import {
  answerGenerationAttempts,
  answerGenerationItems,
  answerGenerationJobs,
  answerGenerationReviews,
  createDb
} from "@answer-generator/db";
import type { PromptMetadata } from "@answer-generator/shared";
import { Queue, QueueEvents, Worker } from "bullmq";
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadProjectEnv } from "./env";
import {
  buildGeneratePayload,
  buildReviewPayload,
  toRetryFeedback,
  type RetryFeedback
} from "./ai-payloads";
import {
  verifyClaimedRubricSchema,
  type ClaimedSchemaFailure
} from "./claimed-schema";
import {
  toPersistedScoringDetails,
  type ReviewAnswerScoringDetails
} from "./review-persistence";

loadProjectEnv();

interface RunJobPayload {
  jobId: string;
  itemId?: string;
  compilationId: string;
}

interface GenerateAnswerResponse {
  answer: string;
  model: string;
  prompt_version: string;
  prompt_metadata: {
    pipeline_version: "generation-pipe-v1";
    schema_version: "rubric-schema-v2";
    base_prompt_version: "base-v1";
    rubric_prompt_version: "rubric-v1";
    retry_prompt_version: "retry-v1";
    loaded_sections: string[];
  };
}

interface ReviewAnswerResponse {
  total_score: number;
  passed: boolean;
  dimensions: Array<{
    dimension_id: string;
    name: string;
    score: number;
    max_score: number;
  }>;
  failed_criteria: Array<{
    criterion_id: string;
    reason: string;
    repair_instruction: string;
  }>;
  preserved_criteria_ids: string[];
  reasons: string[];
  scoring_details: ReviewAnswerScoringDetails;
  reviewer_model: string;
}

interface GeneratedAttempt {
  itemId: string;
  material: string | null;
  question: string;
  answer: string;
  attemptId: string;
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6380";
const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8001";
const workerHeartbeatKey = "answer-generation:worker:heartbeat";
const db = createDb();
const heartbeatQueue = new Queue("answer-generation", { connection: redisConnection(redisUrl) });

void writeWorkerHeartbeat();
const heartbeatTimer = setInterval(() => {
  void writeWorkerHeartbeat();
}, 5000);

const worker = new Worker<RunJobPayload>(
  "answer-generation",
  async (queueJob) => {
    if (queueJob.data.itemId) {
      await runSingleItem(
        queueJob.data.jobId,
        queueJob.data.itemId,
        queueJob.data.compilationId
      );
      return;
    }

    if (!queueJob.data.compilationId) {
      return;
    }

    const [job] = await db
      .update(answerGenerationJobs)
      .set({
        status: "running",
        completedAt: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(answerGenerationJobs.id, queueJob.data.jobId),
          eq(answerGenerationJobs.status, "queued"),
          compilationTokenMatches(queueJob.data.compilationId)
        )
      )
      .returning();

    if (!job) {
      return;
    }

    const rubricSchema = await verifyClaimedRubricSchema(
      job.rubricSchema,
      queueJob.data.compilationId,
      (failure) =>
        failClaimedJobForInvalidSchema(
          job.id,
          queueJob.data.compilationId,
          failure
        )
    );
    if (!rubricSchema) {
      return;
    }

    const initialItems = await db
      .select()
      .from(answerGenerationItems)
      .where(and(eq(answerGenerationItems.jobId, job.id), eq(answerGenerationItems.status, "pending")));

    for (const item of initialItems) {
      await clearItemAttempts(item.id);
    }

    const feedbackByItem = new Map<string, RetryFeedback>();

    for (let attemptNumber = 1; attemptNumber <= job.maxAttempts; attemptNumber += 1) {
      if (await isCancelled(job.id)) {
        return;
      }

      const retryableItems = await db
        .select()
        .from(answerGenerationItems)
        .where(and(eq(answerGenerationItems.jobId, job.id), eq(answerGenerationItems.status, "pending")));

      if (retryableItems.length === 0) {
        break;
      }

      const generatedAttempts: GeneratedAttempt[] = [];

      for (const item of retryableItems) {
        if (await isCancelled(job.id)) {
          await markRunningItemsPending(job.id);
          return;
        }

        await db.update(answerGenerationItems).set({ status: "generating", updatedAt: new Date() }).where(eq(answerGenerationItems.id, item.id));

        try {
          const generated = await generateAnswer({
            material: item.material,
            question: item.question,
            rubricSchema,
            answerMinutes: Number(job.answerMinutes),
            targetMinWords: item.targetMinWords,
            targetWords: item.targetWords,
            targetMaxWords: item.targetMaxWords,
            previousFeedback: feedbackByItem.get(item.id) ?? null
          });

          const [createdAttempt] = await db
            .insert(answerGenerationAttempts)
            .values({
              itemId: item.id,
              attemptNumber,
              status: "generated",
              promptVersion: generated.prompt_version,
              promptMetadata: toPromptMetadata(generated.prompt_metadata),
              model: generated.model,
              answer: generated.answer
            })
            .returning();

          generatedAttempts.push({
            itemId: item.id,
            material: item.material,
            question: item.question,
            answer: generated.answer,
            attemptId: createdAttempt.id
          });
        } catch (error) {
          await db
            .insert(answerGenerationAttempts)
            .values({
              itemId: item.id,
              attemptNumber,
              status: "failed",
              model: "fastapi-ai-service",
              errorMessage: error instanceof Error ? error.message : "生成失败"
            });
          await db.update(answerGenerationItems).set({ status: "failed", updatedAt: new Date() }).where(eq(answerGenerationItems.id, item.id));
        }
      }

      for (const generated of generatedAttempts) {
        if (await isCancelled(job.id)) {
          await markRunningItemsPending(job.id);
          return;
        }

        await db.update(answerGenerationItems).set({ status: "reviewing", updatedAt: new Date() }).where(eq(answerGenerationItems.id, generated.itemId));

        try {
          const review = await reviewAnswer({
            material: generated.material,
            question: generated.question,
            rubricSchema,
            answer: generated.answer,
            passingScore: job.passingScore
          });

          await db
            .update(answerGenerationAttempts)
            .set({ status: "reviewed" })
            .where(eq(answerGenerationAttempts.id, generated.attemptId));

          await db.insert(answerGenerationReviews).values({
            attemptId: generated.attemptId,
            totalScore: review.total_score,
            passed: review.passed,
            dimensions: review.dimensions.map((dimension) => ({
              dimensionId: dimension.dimension_id,
              name: dimension.name,
              score: dimension.score,
              maxScore: dimension.max_score
            })),
            failedCriteria: review.failed_criteria.map((criterion) => ({
              criterionId: criterion.criterion_id,
              reason: criterion.reason,
              repairInstruction: criterion.repair_instruction
            })),
            preservedCriteriaIds: review.preserved_criteria_ids,
            reasons: review.reasons,
            scoringDetails: toPersistedScoringDetails(review.scoring_details),
            reviewerModel: review.reviewer_model
          });

          if (review.passed) {
            await db
              .update(answerGenerationItems)
              .set({
                status: "passed",
                finalAnswer: generated.answer,
                finalScore: review.total_score,
                needsManualReview: false,
                updatedAt: new Date()
              })
              .where(eq(answerGenerationItems.id, generated.itemId));
            continue;
          }

          feedbackByItem.set(generated.itemId, toRetryFeedback(review));
          await db
            .update(answerGenerationItems)
            .set({
              status: attemptNumber >= job.maxAttempts ? "needs_review" : "pending",
              finalAnswer: generated.answer,
              finalScore: review.total_score,
              needsManualReview: attemptNumber >= job.maxAttempts,
              updatedAt: new Date()
            })
            .where(eq(answerGenerationItems.id, generated.itemId));
        } catch (error) {
          await db
            .update(answerGenerationAttempts)
            .set({ status: "failed", errorMessage: error instanceof Error ? error.message : "审核失败" })
            .where(eq(answerGenerationAttempts.id, generated.attemptId));
          await db.update(answerGenerationItems).set({ status: "failed", updatedAt: new Date() }).where(eq(answerGenerationItems.id, generated.itemId));
        }
      }
    }

    const latestJob = await getJob(job.id);
    if (latestJob?.status !== "cancelled") {
      await markRunningItemsNeedsReview(job.id);
      const finalItems = await db
        .select()
        .from(answerGenerationItems)
        .where(eq(answerGenerationItems.jobId, job.id));
      const allPassed = finalItems.length > 0 && finalItems.every((item) => item.status === "passed");
      await db
        .update(answerGenerationJobs)
        .set({ status: allPassed ? "completed" : "needs_review", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(answerGenerationJobs.id, job.id));
    }
  },
  {
    connection: redisConnection(redisUrl),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1)
  }
);

async function runSingleItem(
  jobId: string,
  itemId: string,
  compilationId: string
) {
  if (!compilationId) {
    return;
  }

  const [job] = await db
    .update(answerGenerationJobs)
    .set({ status: "running", completedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(answerGenerationJobs.id, jobId),
        eq(answerGenerationJobs.status, "queued"),
        compilationTokenMatches(compilationId)
      )
    )
    .returning();
  if (!job) {
    return;
  }

  const rubricSchema = await verifyClaimedRubricSchema(
    job.rubricSchema,
    compilationId,
    (failure) =>
      failClaimedJobForInvalidSchema(job.id, compilationId, failure)
  );
  if (!rubricSchema) {
    return;
  }

  const [item] = await db
    .select()
    .from(answerGenerationItems)
    .where(and(eq(answerGenerationItems.jobId, jobId), eq(answerGenerationItems.id, itemId)));

  if (!item) {
    return;
  }

  await clearItemAttempts(item.id);

  let feedback: RetryFeedback | null = null;
  for (let attemptNumber = 1; attemptNumber <= job.maxAttempts; attemptNumber += 1) {
    if (await isCancelled(job.id)) {
      await markItemPending(item.id);
      return;
    }

    await db.update(answerGenerationItems).set({ status: "generating", updatedAt: new Date() }).where(eq(answerGenerationItems.id, item.id));

    let generated: GenerateAnswerResponse;
    let attemptId: string;
    try {
      generated = await generateAnswer({
        material: item.material,
        question: item.question,
        rubricSchema,
        answerMinutes: Number(job.answerMinutes),
        targetMinWords: item.targetMinWords,
        targetWords: item.targetWords,
        targetMaxWords: item.targetMaxWords,
        previousFeedback: feedback
      });

      const [createdAttempt] = await db
        .insert(answerGenerationAttempts)
        .values({
          itemId: item.id,
          attemptNumber,
          status: "generated",
          promptVersion: generated.prompt_version,
          promptMetadata: toPromptMetadata(generated.prompt_metadata),
          model: generated.model,
          answer: generated.answer
        })
        .returning();
      attemptId = createdAttempt.id;
    } catch (error) {
      await db.insert(answerGenerationAttempts).values({
        itemId: item.id,
        attemptNumber,
        status: "failed",
        model: "fastapi-ai-service",
        errorMessage: error instanceof Error ? error.message : "生成失败"
      });
      await db.update(answerGenerationItems).set({ status: "failed", updatedAt: new Date() }).where(eq(answerGenerationItems.id, item.id));
      await updateJobFinalStatus(job.id, compilationId);
      return;
    }

    if (await isCancelled(job.id)) {
      await markItemPending(item.id);
      return;
    }

    await db.update(answerGenerationItems).set({ status: "reviewing", updatedAt: new Date() }).where(eq(answerGenerationItems.id, item.id));

    try {
      const review = await reviewAnswer({
        material: item.material,
        question: item.question,
        rubricSchema,
        answer: generated.answer,
        passingScore: job.passingScore
      });

      await db.update(answerGenerationAttempts).set({ status: "reviewed" }).where(eq(answerGenerationAttempts.id, attemptId));

      await db.insert(answerGenerationReviews).values({
        attemptId,
        totalScore: review.total_score,
        passed: review.passed,
        dimensions: review.dimensions.map((dimension) => ({
          dimensionId: dimension.dimension_id,
          name: dimension.name,
          score: dimension.score,
          maxScore: dimension.max_score
        })),
        failedCriteria: review.failed_criteria.map((criterion) => ({
          criterionId: criterion.criterion_id,
          reason: criterion.reason,
          repairInstruction: criterion.repair_instruction
        })),
        preservedCriteriaIds: review.preserved_criteria_ids,
        reasons: review.reasons,
        scoringDetails: toPersistedScoringDetails(review.scoring_details),
        reviewerModel: review.reviewer_model
      });

      if (review.passed) {
        await db
          .update(answerGenerationItems)
          .set({
            status: "passed",
            finalAnswer: generated.answer,
            finalScore: review.total_score,
            needsManualReview: false,
            updatedAt: new Date()
          })
          .where(eq(answerGenerationItems.id, item.id));
        await updateJobFinalStatus(job.id, compilationId);
        return;
      }

      feedback = toRetryFeedback(review);
      await db
        .update(answerGenerationItems)
        .set({
          status: attemptNumber >= job.maxAttempts ? "needs_review" : "pending",
          finalAnswer: generated.answer,
          finalScore: review.total_score,
          needsManualReview: attemptNumber >= job.maxAttempts,
          updatedAt: new Date()
        })
        .where(eq(answerGenerationItems.id, item.id));

      if (attemptNumber >= job.maxAttempts) {
        await updateJobFinalStatus(job.id, compilationId);
        return;
      }
    } catch (error) {
      await db
        .update(answerGenerationAttempts)
        .set({ status: "failed", errorMessage: error instanceof Error ? error.message : "审核失败" })
        .where(eq(answerGenerationAttempts.id, attemptId));
      await db.update(answerGenerationItems).set({ status: "failed", updatedAt: new Date() }).where(eq(answerGenerationItems.id, item.id));
      await updateJobFinalStatus(job.id, compilationId);
      return;
    }
  }
}

const events = new QueueEvents("answer-generation", { connection: redisConnection(redisUrl) });

events.on("failed", async ({ failedReason }) => {
  console.error(failedReason);
});

worker.on("ready", () => {
  console.log("answer-generation worker ready");
});

worker.on("closed", () => {
  clearInterval(heartbeatTimer);
});

async function writeWorkerHeartbeat() {
  const client = await heartbeatQueue.client;
  await client.set(workerHeartbeatKey, String(Date.now()), { EX: 15 });
}

async function generateAnswer(
  input: Parameters<typeof buildGeneratePayload>[0]
) {
  const response = await fetch(`${aiServiceUrl}/ai/generate-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGeneratePayload(input))
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as GenerateAnswerResponse;
}

async function reviewAnswer(
  input: Parameters<typeof buildReviewPayload>[0]
) {
  const response = await fetch(`${aiServiceUrl}/ai/review-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildReviewPayload(input))
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ReviewAnswerResponse;
}

function toPromptMetadata(
  metadata: GenerateAnswerResponse["prompt_metadata"]
): PromptMetadata {
  return {
    pipelineVersion: metadata.pipeline_version,
    schemaVersion: metadata.schema_version,
    basePromptVersion: metadata.base_prompt_version,
    rubricPromptVersion: metadata.rubric_prompt_version,
    retryPromptVersion: metadata.retry_prompt_version,
    loadedSections: metadata.loaded_sections
  };
}

function compilationTokenMatches(compilationId: string) {
  return sql`${answerGenerationJobs.rubricCompilation}->'details'->>'compilationId' = ${compilationId}`;
}

async function failClaimedJobForInvalidSchema(
  jobId: string,
  compilationId: string,
  failure: ClaimedSchemaFailure
) {
  const now = new Date();
  await db
    .update(answerGenerationJobs)
    .set({
      status: "failed",
      rubricCompilation: { ...failure, updatedAt: now.toISOString() },
      completedAt: now,
      updatedAt: now
    })
    .where(
      and(
        eq(answerGenerationJobs.id, jobId),
        eq(answerGenerationJobs.status, "running"),
        compilationTokenMatches(compilationId)
      )
    );
}

async function getJob(jobId: string) {
  const [job] = await db
    .select()
    .from(answerGenerationJobs)
    .where(eq(answerGenerationJobs.id, jobId));
  return job;
}

async function isCancelled(jobId: string) {
  const job = await getJob(jobId);
  return job?.status === "cancelled";
}

async function markRunningItemsPending(jobId: string) {
  await db
    .update(answerGenerationItems)
    .set({ status: "pending", updatedAt: new Date() })
    .where(and(eq(answerGenerationItems.jobId, jobId), inArray(answerGenerationItems.status, ["generating", "reviewing"])));
}

async function markItemPending(itemId: string) {
  await db
    .update(answerGenerationItems)
    .set({ status: "pending", updatedAt: new Date() })
    .where(eq(answerGenerationItems.id, itemId));
}

async function markRunningItemsNeedsReview(jobId: string) {
  await db
    .update(answerGenerationItems)
    .set({ status: "needs_review", needsManualReview: true, updatedAt: new Date() })
    .where(and(eq(answerGenerationItems.jobId, jobId), inArray(answerGenerationItems.status, ["generating", "reviewing"])));
}

async function updateJobFinalStatus(jobId: string, compilationId: string) {
  const finalItems = await db
    .select()
    .from(answerGenerationItems)
    .where(eq(answerGenerationItems.jobId, jobId));
  const allPassed = finalItems.length > 0 && finalItems.every((item) => item.status === "passed");
  await db
    .update(answerGenerationJobs)
    .set({ status: allPassed ? "completed" : "needs_review", completedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(answerGenerationJobs.id, jobId),
        eq(answerGenerationJobs.status, "running"),
        compilationTokenMatches(compilationId)
      )
    );
}

async function clearItemAttempts(itemId: string) {
  const attempts = await db
    .select()
    .from(answerGenerationAttempts)
    .where(eq(answerGenerationAttempts.itemId, itemId));
  const attemptIds = attempts.map((attempt) => attempt.id);

  if (attemptIds.length === 0) {
    return;
  }

  await db.delete(answerGenerationReviews).where(inArray(answerGenerationReviews.attemptId, attemptIds));
  await db.delete(answerGenerationAttempts).where(inArray(answerGenerationAttempts.id, attemptIds));
}

function redisConnection(value: string) {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number(url.pathname.replace("/", "") || 0)
  };
}
