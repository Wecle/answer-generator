import {
  answerGenerationAttempts,
  answerGenerationItems,
  answerGenerationJobs,
  answerGenerationReviews,
  createDb
} from "@answer-generator/db";
import { estimateAnswerWordRange, summarizeJobProgress, type GenerationItemStatus } from "@answer-generator/shared";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { resetJobResults, updatePendingItemTargets } from "@/lib/job-reset";
import { compileRubricLocally } from "@/lib/rubric-compiler";

const updateJobSchema = z.object({
  title: z.string().min(1),
  rubric: z.string().min(1),
  answerMinutes: z.number().positive(),
  passingScore: z.number().int().min(0).max(100),
  maxAttempts: z.number().int().min(1).max(10),
  applyMode: z.enum(["regenerate_all", "future_only"])
});

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

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const input = updateJobSchema.parse(await request.json());
  const db = createDb();
  const range = estimateAnswerWordRange(input.answerMinutes);
  const compiled = compileRubricLocally({
    rubric: input.rubric,
    answerMinutes: input.answerMinutes,
    passingScore: input.passingScore
  });
  const [job] = await db
    .update(answerGenerationJobs)
    .set({
      title: input.title,
      rubric: input.rubric,
      compiledPrompt: compiled.compiledPrompt,
      rubricSchema: compiled.rubricSchema,
      answerMinutes: String(input.answerMinutes),
      passingScore: input.passingScore,
      maxAttempts: input.maxAttempts,
      status: "compiling_rubric",
      updatedAt: new Date()
    })
    .where(eq(answerGenerationJobs.id, id))
    .returning();

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  if (input.applyMode === "regenerate_all") {
    const reset = await resetJobResults(db, id, "all");
    await updatePendingItemTargets(db, id, range);
    return Response.json({ job, resetItems: reset.resetItems, updatedPendingItems: reset.resetItems });
  }

  const updatedPendingItems = await updatePendingItemTargets(db, id, range);
  return Response.json({ job, resetItems: 0, updatedPendingItems });
}
