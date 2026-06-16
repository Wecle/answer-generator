import {
  answerGenerationAttempts,
  answerGenerationItems,
  answerGenerationReviews,
  type DbClient
} from "@answer-generator/db";
import { and, eq, inArray, ne } from "drizzle-orm";

export async function resetJobResults(db: DbClient, jobId: string, scope: "retryable" | "all" = "retryable") {
  const allItems = await db.select().from(answerGenerationItems).where(eq(answerGenerationItems.jobId, jobId));
  const items =
    scope === "all"
      ? allItems
      : await db
          .select()
          .from(answerGenerationItems)
          .where(and(eq(answerGenerationItems.jobId, jobId), ne(answerGenerationItems.status, "passed")));
  const itemIds = items.map((item) => item.id);

  if (itemIds.length > 0) {
    const attempts = await db
      .select()
      .from(answerGenerationAttempts)
      .where(inArray(answerGenerationAttempts.itemId, itemIds));
    const attemptIds = attempts.map((attempt) => attempt.id);

    if (attemptIds.length > 0) {
      await db.delete(answerGenerationReviews).where(inArray(answerGenerationReviews.attemptId, attemptIds));
      await db.delete(answerGenerationAttempts).where(inArray(answerGenerationAttempts.id, attemptIds));
    }

    await db
      .update(answerGenerationItems)
      .set({
        status: "pending",
        finalAnswer: null,
        finalScore: null,
        needsManualReview: false,
        updatedAt: new Date()
      })
      .where(inArray(answerGenerationItems.id, itemIds));
  }

  return { resetItems: itemIds.length, totalItems: allItems.length };
}

export async function updatePendingItemTargets(
  db: DbClient,
  jobId: string,
  range: { minWords: number; targetWords: number; maxWords: number }
) {
  const updated = await db
    .update(answerGenerationItems)
    .set({
      targetMinWords: range.minWords,
      targetWords: range.targetWords,
      targetMaxWords: range.maxWords,
      updatedAt: new Date()
    })
    .where(and(eq(answerGenerationItems.jobId, jobId), eq(answerGenerationItems.status, "pending")))
    .returning({ id: answerGenerationItems.id });

  return updated.length;
}
