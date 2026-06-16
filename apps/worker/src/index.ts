import {
  answerGenerationAttempts,
  answerGenerationItems,
  answerGenerationJobs,
  answerGenerationReviews,
  createDb
} from "@answer-generator/db";
import { Queue, QueueEvents, Worker } from "bullmq";
import { and, eq, inArray, ne } from "drizzle-orm";
import { loadProjectEnv } from "./env";

loadProjectEnv();

interface RunJobPayload {
  jobId: string;
}

interface GenerateAnswerResponse {
  answer: string;
  model: string;
  prompt_version: string;
}

interface ReviewAnswerResponse {
  total_score: number;
  passed: boolean;
  dimensions: Array<{ name: string; score: number; max_score: number }>;
  reasons: string[];
  reviewer_model: string;
}

interface RubricSchema {
  rolePrompt: string;
  answerPrinciples: string[];
  dimensions: Array<{ name: string; maxScore: number; criteria: string[]; pitfalls: string[] }>;
  retryPolicy: string[];
  outputRules: string[];
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
    const current = await getJob(queueJob.data.jobId);
    if (!current || current.status === "cancelled") {
      return;
    }

    const [job] = await db
      .update(answerGenerationJobs)
      .set({ status: "running", startedAt: current.startedAt ?? new Date(), completedAt: null, updatedAt: new Date() })
      .where(and(eq(answerGenerationJobs.id, queueJob.data.jobId), ne(answerGenerationJobs.status, "cancelled")))
      .returning();

    if (!job || job.status === "cancelled") {
      return;
    }

    const initialItems = await db
      .select()
      .from(answerGenerationItems)
      .where(and(eq(answerGenerationItems.jobId, job.id), ne(answerGenerationItems.status, "passed")));

    for (const item of initialItems) {
      await clearItemAttempts(item.id);
    }

    const feedbackByItem = new Map<string, string[]>();

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
            rubric: job.rubric,
            compiledPrompt: job.compiledPrompt,
            rubricSchema: job.rubricSchema,
            answerMinutes: Number(job.answerMinutes),
            targetWords: item.targetWords,
            previousFeedback: feedbackByItem.get(item.id) ?? []
          });

          const [createdAttempt] = await db
            .insert(answerGenerationAttempts)
            .values({
              itemId: item.id,
              attemptNumber,
              status: "generated",
              promptVersion: generated.prompt_version,
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
            rubric: job.rubric,
            rubricSchema: job.rubricSchema,
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
              name: dimension.name,
              score: dimension.score,
              maxScore: dimension.max_score
            })),
            reasons: review.reasons,
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

          feedbackByItem.set(generated.itemId, review.reasons);
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

async function generateAnswer(input: {
  material: string | null;
  question: string;
  rubric: string;
  compiledPrompt: string | null;
  rubricSchema: RubricSchema | null;
  answerMinutes: number;
  targetWords: number;
  previousFeedback: string[];
}) {
  const response = await fetch(`${aiServiceUrl}/ai/generate-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      material: input.material,
      question: input.question,
      rubric: input.rubric,
      compiled_prompt: input.compiledPrompt,
      rubric_schema: input.rubricSchema ? toApiRubricSchema(input.rubricSchema) : null,
      answer_minutes: input.answerMinutes,
      target_words: input.targetWords,
      previous_feedback: input.previousFeedback
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as GenerateAnswerResponse;
}

async function reviewAnswer(input: {
  material: string | null;
  question: string;
  rubric: string;
  rubricSchema: RubricSchema | null;
  answer: string;
  passingScore: number;
}) {
  const response = await fetch(`${aiServiceUrl}/ai/review-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      material: input.material,
      question: input.question,
      rubric: input.rubric,
      rubric_schema: input.rubricSchema ? toApiRubricSchema(input.rubricSchema) : null,
      answer: input.answer,
      passing_score: input.passingScore
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as ReviewAnswerResponse;
}

function toApiRubricSchema(schema: RubricSchema) {
  return {
    role_prompt: schema.rolePrompt,
    answer_principles: schema.answerPrinciples,
    dimensions: schema.dimensions.map((dimension) => ({
      name: dimension.name,
      max_score: dimension.maxScore,
      criteria: dimension.criteria,
      pitfalls: dimension.pitfalls
    })),
    retry_policy: schema.retryPolicy,
    output_rules: schema.outputRules
  };
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
