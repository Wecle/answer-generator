import { answerGenerationJobs, createDb } from "@answer-generator/db";
import { eq } from "drizzle-orm";
import { isRubricCompiling } from "@/lib/job-status";
import { compileRubricForJob } from "@/lib/rubric-compiler";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const [job] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  let compiled;
  try {
    compiled = await compileRubricForJob({
      rubric: job.rubric,
      answerMinutes: Number(job.answerMinutes),
      passingScore: job.passingScore
    });
  } catch (error) {
    await db
      .update(answerGenerationJobs)
      .set({
        status: "failed",
        updatedAt: new Date()
      })
      .where(eq(answerGenerationJobs.id, job.id));
    return Response.json({ error: error instanceof Error ? error.message : "评分标准分析失败" }, { status: 502 });
  }

  const [updated] = await db
    .update(answerGenerationJobs)
    .set({
      compiledPrompt: compiled.compiledPrompt,
      rubricSchema: compiled.rubricSchema,
      status: isRubricCompiling(job.status) ? "draft" : job.status,
      updatedAt: new Date()
    })
    .where(eq(answerGenerationJobs.id, job.id))
    .returning();

  return Response.json({ jobId: updated.id, status: updated.status });
}
