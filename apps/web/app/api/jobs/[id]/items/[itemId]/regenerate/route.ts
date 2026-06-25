import { answerGenerationJobs, createDb } from "@answer-generator/db";
import { shouldPollJobStatus, type GenerationJobStatus } from "@answer-generator/shared";
import { eq } from "drizzle-orm";
import { isRubricCompiling } from "@/lib/job-status";
import { resetJobItemResult } from "@/lib/job-reset";
import { enqueueGenerationItem } from "@/lib/queue";

export async function POST(_: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await context.params;
  const db = createDb();
  const [currentJob] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!currentJob) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  if (isRubricCompiling(currentJob.status)) {
    return Response.json({ error: "评分标准分析中，请稍后再重新生成" }, { status: 409 });
  }

  if (shouldPollJobStatus(currentJob.status as GenerationJobStatus)) {
    return Response.json({ error: "任务正在生成中，请稍后再重新生成" }, { status: 409 });
  }

  const reset = await resetJobItemResult(db, id, itemId);
  if (reset.resetItems === 0) {
    return Response.json({ error: "Item not found" }, { status: 404 });
  }

  const [job] = await db
    .update(answerGenerationJobs)
    .set({
      updatedAt: new Date()
    })
    .where(eq(answerGenerationJobs.id, id))
    .returning();

  const queue = await enqueueGenerationItem(job.id, itemId);
  return Response.json({ jobId: job.id, itemId, queued: queue.enqueued, workerOnline: queue.workerOnline });
}
