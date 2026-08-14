import { answerGenerationJobs, createDb } from "@answer-generator/db";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { statusAfterSuccessfulRubricCompilation } from "@/lib/job-status";
import {
  compileRubricForJob,
  RubricCompilationRequestError
} from "@/lib/rubric-compiler";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const [job] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const compilationId = crypto.randomUUID();
  const [compilationJob] = await db
    .update(answerGenerationJobs)
    .set({
      rubricCompilation: {
        stage: "compiling_schema",
        details: { compilationId },
        updatedAt: new Date().toISOString()
      },
      updatedAt: new Date()
    })
    .where(
      and(
        eq(answerGenerationJobs.id, job.id),
        notInArray(answerGenerationJobs.status, ["queued", "running"])
      )
    )
    .returning();

  if (!compilationJob) {
    return Response.json(
      { error: "任务已被其他请求更新，请刷新后重试" },
      { status: 409 }
    );
  }

  let compiled;
  try {
    compiled = await compileRubricForJob({
      rubric: compilationJob.rubric,
      answerMinutes: Number(compilationJob.answerMinutes),
      passingScore: compilationJob.passingScore
    });
  } catch (error) {
    const compilation =
      error instanceof RubricCompilationRequestError
        ? error.compilation
        : {
            stage: "failed",
            code: "AI_SERVICE_ERROR",
            message: error instanceof Error ? error.message : "评分标准分析失败",
            updatedAt: new Date().toISOString()
          };
    const failed = await db
      .update(answerGenerationJobs)
      .set({
        status: "failed",
        rubricCompilation: {
          ...compilation,
          details: { ...compilation.details, compilationId }
        },
        updatedAt: new Date()
      })
      .where(compilationTokenMatches(compilationJob.id, compilationId))
      .returning({ id: answerGenerationJobs.id });
    if (failed.length === 0) {
      return Response.json(
        { error: "评分标准分析结果已过期，请使用最新任务状态" },
        { status: 409 }
      );
    }
    return Response.json(
      { detail: compilation },
      { status: error instanceof RubricCompilationRequestError ? 422 : 502 }
    );
  }

  const [updated] = await db
    .update(answerGenerationJobs)
    .set({
      compiledPrompt: null,
      rubricSchema: compiled.rubricSchema,
      rubricCompilation: {
        ...compiled.compilation,
        details: { compilationId }
      },
      status: statusAfterSuccessfulRubricCompilation(compilationJob.status),
      updatedAt: new Date()
    })
    .where(compilationTokenMatches(compilationJob.id, compilationId))
    .returning();

  if (!updated) {
    return Response.json(
      { error: "评分标准分析结果已过期，请使用最新任务状态" },
      { status: 409 }
    );
  }

  return Response.json({ jobId: updated.id, status: updated.status });
}

function compilationTokenMatches(jobId: string, compilationId: string) {
  return sql`${answerGenerationJobs.id} = ${jobId} and ${answerGenerationJobs.rubricCompilation}->'details'->>'compilationId' = ${compilationId}`;
}
