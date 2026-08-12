import { answerGenerationJobs, createDb } from "@answer-generator/db";
import {
  isVerifiedRubricSchemaV2,
  shouldPollJobStatus,
  type GenerationJobStatus
} from "@answer-generator/shared";
import { eq } from "drizzle-orm";
import { isRubricCompiling } from "@/lib/job-status";
import { resetJobItemResult } from "@/lib/job-reset";
import { enqueueGenerationItem } from "@/lib/queue";

export async function POST(
  _: Request,
  context: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id, itemId } = await context.params;
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
          { error: "评分标准分析中，请稍后再重新生成" },
          { status: 409 }
        )
      };
    }

    if (shouldPollJobStatus(currentJob.status as GenerationJobStatus)) {
      return {
        response: Response.json(
          { error: "任务正在生成中，请稍后再重新生成" },
          { status: 409 }
        )
      };
    }

    const reset = await resetJobItemResult(tx, id, itemId);
    if (reset.resetItems === 0) {
      return { response: Response.json({ error: "Item not found" }, { status: 404 }) };
    }

    const [job] = await tx
      .update(answerGenerationJobs)
      .set({
        status: "queued",
        startedAt: new Date(),
        completedAt: null,
        updatedAt: new Date()
      })
      .where(eq(answerGenerationJobs.id, id))
      .returning();

    return { job, compilationId };
  });

  if ("response" in result) {
    return result.response;
  }

  const queue = await enqueueGenerationItem(
    result.job.id,
    itemId,
    result.compilationId
  );
  return Response.json({
    jobId: result.job.id,
    itemId,
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
