import { answerGenerationItems, answerGenerationJobs, createDb } from "@answer-generator/db";
import { estimateAnswerWordRange } from "@answer-generator/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";

const createItemsSchema = z.object({
  items: z.array(
    z.object({
      title: z.string().min(1).default("未命名题目"),
      material: z.string().optional(),
      question: z.string().min(1)
    })
  ).min(1)
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const input = createItemsSchema.parse(await request.json());
  const db = createDb();
  const [job] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  if (job.status === "compiling_rubric") {
    return Response.json({ error: "评分标准分析中，请稍后再添加题目" }, { status: 409 });
  }

  const range = estimateAnswerWordRange(Number(job.answerMinutes));
  const inserted = await db
    .insert(answerGenerationItems)
    .values(
      input.items.map((item) => ({
        jobId: job.id,
        title: item.title,
        material: item.material || null,
        question: item.question,
        targetMinWords: range.minWords,
        targetWords: range.targetWords,
        targetMaxWords: range.maxWords
      }))
    )
    .returning();

  if (job.status !== "running" && job.status !== "queued") {
    await db
      .update(answerGenerationJobs)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(answerGenerationJobs.id, job.id));
  }

  return Response.json({ items: inserted, queued: false });
}
