import { answerGenerationJobs, createDb } from "@answer-generator/db";
import { isVerifiedRubricSchemaV2 } from "@answer-generator/shared";
import { eq } from "drizzle-orm";
import { isRubricCompiling } from "@/lib/job-status";
import { resetJobResults } from "@/lib/job-reset";
import { enqueueGenerationJob } from "@/lib/queue";

export async function POST(
  _: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const db = createDb();
  const result = await db.transaction(async (tx) => {
    const [currentJob] = await tx
      .select()
      .from(answerGenerationJobs)
      .where(eq(answerGenerationJobs.id, id))
      .for("update");

    if (!currentJob) {
      return { response: Response.json({ error: "Job not found" }, { status: 404 }) };
    }

    if (!isVerifiedRubricSchemaV2(currentJob.rubricSchema)) {
      return {
        response: Response.json(
          { error: "评分标准尚未通过完整性审计，请重新分析评分标准" },
          { status: 409 }
        )
      };
    }
    const compilationId = getCompilationId(currentJob.rubricCompilation);
    if (!compilationId) {
      return {
        response: Response.json(
          { error: "评分标准缺少可追溯的编译版本，请重新分析评分标准" },
          { status: 409 }
        )
      };
    }

    if (isRubricCompiling(currentJob.status)) {
      return {
        response: Response.json(
          { error: "评分标准分析中，请稍后再开始任务" },
          { status: 409 }
        )
      };
    }
    if (currentJob.status === "queued" || currentJob.status === "running") {
      return {
        response: Response.json(
          { error: "任务正在生成中，请稍后再开始任务" },
          { status: 409 }
        )
      };
    }

    const reset = await resetJobResults(tx, id);
    const nextStatus = reset.resetItems > 0 ? "queued" : "completed";
    const now = new Date();
    const [job] = await tx
      .update(answerGenerationJobs)
      .set({
        status: nextStatus,
        startedAt: now,
        completedAt: reset.resetItems > 0 ? null : now,
        updatedAt: now
      })
      .where(eq(answerGenerationJobs.id, id))
      .returning();

    return { job, reset, compilationId };
  });

  if ("response" in result) {
    return result.response;
  }
  if (result.reset.resetItems === 0) {
    return Response.json({ jobId: result.job.id, queued: false });
  }

  const queue = await enqueueGenerationJob(
    result.job.id,
    result.compilationId
  );
  return Response.json({
    jobId: result.job.id,
    queued: queue.enqueued,
    workerOnline: queue.workerOnline
  });
}

function getCompilationId(
  compilation: { details?: Record<string, unknown> } | null
): string | null {
  const value = compilation?.details?.compilationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
