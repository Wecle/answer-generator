import { answerGenerationJobs, createDb } from "@answer-generator/db";
import { eq } from "drizzle-orm";
import { isRubricCompiling } from "@/lib/job-status";
import { resetJobResults } from "@/lib/job-reset";
import { enqueueGenerationJob } from "@/lib/queue";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const [currentJob] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!currentJob) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  if (isRubricCompiling(currentJob.status)) {
    return Response.json({ error: "评分标准分析中，请稍后再开始任务" }, { status: 409 });
  }

  const reset = await resetJobResults(db, id);
  const nextStatus = reset.resetItems > 0 ? "queued" : "completed";
  const now = new Date();
  const [job] = await db
    .update(answerGenerationJobs)
    .set({
      status: nextStatus,
      startedAt: now,
      completedAt: reset.resetItems > 0 ? null : now,
      updatedAt: now
    })
    .where(eq(answerGenerationJobs.id, id))
    .returning();

  if (reset.resetItems === 0) {
    return Response.json({ jobId: job.id, queued: false });
  }

  const queue = await enqueueGenerationJob(job.id);
  return Response.json({ jobId: job.id, queued: queue.enqueued, workerOnline: queue.workerOnline });
}
