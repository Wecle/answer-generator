import {
  answerGenerationAttempts,
  answerGenerationItems,
  answerGenerationJobs,
  answerGenerationReviews,
  createDb
} from "@answer-generator/db";
import { summarizeJobProgress, type GenerationItemStatus } from "@answer-generator/shared";
import { eq, inArray } from "drizzle-orm";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const [job] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const items = await db.select().from(answerGenerationItems).where(eq(answerGenerationItems.jobId, job.id));
  const itemIds = items.map((item) => item.id);
  const attempts = itemIds.length
    ? await db.select().from(answerGenerationAttempts).where(inArray(answerGenerationAttempts.itemId, itemIds))
    : [];
  const attemptIds = attempts.map((attempt) => attempt.id);
  const reviews = attemptIds.length
    ? await db.select().from(answerGenerationReviews).where(inArray(answerGenerationReviews.attemptId, attemptIds))
    : [];

  return Response.json({
    job,
    progress: summarizeJobProgress(items.map((item) => item.status as GenerationItemStatus)),
    items: items.map((item) => {
      const itemAttempts = attempts
        .filter((attempt) => attempt.itemId === item.id)
        .map((attempt) => ({
          ...attempt,
          review: reviews.find((review) => review.attemptId === attempt.id) ?? null
        }));

      return {
        ...item,
        attempts: itemAttempts
      };
    })
  });
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const deleted = await db
    .delete(answerGenerationJobs)
    .where(eq(answerGenerationJobs.id, id))
    .returning({ id: answerGenerationJobs.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  return Response.json({ deleted: true });
}
