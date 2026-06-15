import { answerGenerationItems, answerGenerationJobs, createDb } from "@answer-generator/db";
import { and, eq, inArray } from "drizzle-orm";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const [job] = await db
    .update(answerGenerationJobs)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(answerGenerationJobs.id, id))
    .returning();

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  await db
    .update(answerGenerationItems)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(answerGenerationItems.jobId, id), inArray(answerGenerationItems.status, ["generating", "reviewing"])));

  return Response.json({ jobId: job.id, status: job.status });
}
