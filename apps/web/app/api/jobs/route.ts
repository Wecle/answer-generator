import { createDb, answerGenerationItems, answerGenerationJobs } from "@answer-generator/db";
import { estimateAnswerWordRange, summarizeJobProgress, type GenerationItemStatus } from "@answer-generator/shared";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { compileRubricLocally } from "@/lib/rubric-compiler";

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
  const compiled = compileRubricLocally({
    rubric: input.rubric,
    answerMinutes: input.answerMinutes,
    passingScore: input.passingScore
  });
  const [job] = await db
    .insert(answerGenerationJobs)
    .values({
      title: input.title,
      rubric: input.rubric,
      compiledPrompt: compiled.compiledPrompt,
      rubricSchema: compiled.rubricSchema,
      answerMinutes: String(input.answerMinutes),
      passingScore: input.passingScore,
      maxAttempts: input.maxAttempts,
      status: "compiling_rubric"
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

  return Response.json({ jobId: job.id, queued: false });
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
      const terminalStatus = job.status === "completed" || job.status === "needs_review" || job.status === "failed" || job.status === "cancelled";
      return {
        id: job.id,
        title: job.title,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt ?? (job.status === "draft" || job.status === "compiling_rubric" ? null : job.createdAt),
        completedAt: job.completedAt ?? (terminalStatus ? job.updatedAt : null),
        progress: summarizeJobProgress(jobItems.map((item) => item.status as GenerationItemStatus))
      };
    })
  });
}
