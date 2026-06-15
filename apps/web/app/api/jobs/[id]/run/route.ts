import { answerGenerationJobs, createDb } from "@answer-generator/db";
import { eq } from "drizzle-orm";
import { resetJobResults } from "@/lib/job-reset";
import { enqueueGenerationJob } from "@/lib/queue";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const reset = await resetJobResults(db, id);
  const nextStatus = reset.resetItems > 0 ? "queued" : "completed";
  const [job] = await db
    .update(answerGenerationJobs)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(answerGenerationJobs.id, id))
    .returning();

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  if (reset.resetItems === 0) {
    return Response.json({ jobId: job.id, queued: false });
  }

  const queue = await enqueueGenerationJob(job.id);
  return Response.json({ jobId: job.id, queued: queue.enqueued, workerOnline: queue.workerOnline });
}
