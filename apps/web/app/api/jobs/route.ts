import { createDb, answerGenerationItems, answerGenerationJobs } from "@answer-generator/db";
import { estimateAnswerWordRange, summarizeJobProgress, type GenerationItemStatus } from "@answer-generator/shared";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { deriveJobTiming, RUBRIC_COMPILING_STATUS } from "@/lib/job-status";

const itemSchema = z.object({
  title: z.string().optional(),
  material: z.string().optional(),
  question: z.string().min(1)
});

const createJobSchema = z.object({
  title: z.string().min(1),
  rubric: z.string().min(1),
  answerMinutes: z.number().positive(),
  passingScore: z.number().int().min(0).max(100),
  maxAttempts: z.number().int().min(1).max(10),
  items: z.array(itemSchema).default([])
});

export async function POST(request: Request) {
  const input = createJobSchema.parse(await request.json());
  const db = createDb();
  const [job] = await db
    .insert(answerGenerationJobs)
    .values({
      title: input.title,
      rubric: input.rubric,
      compiledPrompt: null,
      rubricSchema: null,
      answerMinutes: String(input.answerMinutes),
      passingScore: input.passingScore,
      maxAttempts: input.maxAttempts,
      status: RUBRIC_COMPILING_STATUS
    })
    .returning();

  const range = estimateAnswerWordRange(input.answerMinutes);
  if (input.items.length > 0) {
    await db.insert(answerGenerationItems).values(
      input.items.map((item) => ({
        jobId: job.id,
        title: item.title || "未命名题目",
        material: item.material || null,
        question: item.question,
        targetMinWords: range.minWords,
        targetWords: range.targetWords,
        targetMaxWords: range.maxWords
      }))
    );
  }

  return Response.json({ jobId: job.id, status: job.status, queued: false });
}

export async function GET() {
  let db;
  try {
    db = createDb();
  } catch {
    return Response.json({ jobs: [], databaseReady: false });
  }

  const jobs = await db.select().from(answerGenerationJobs).orderBy(desc(answerGenerationJobs.createdAt));
  const items = await db.select().from(answerGenerationItems);

  return Response.json({
    databaseReady: true,
    jobs: jobs.map((job) => {
      const jobItems = items.filter((item) => item.jobId === job.id);
      const timing = deriveJobTiming(job);
      return {
        id: job.id,
        title: job.title,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: timing.startedAt,
        completedAt: timing.completedAt,
        progress: summarizeJobProgress(jobItems.map((item) => item.status as GenerationItemStatus))
      };
    })
  });
}
