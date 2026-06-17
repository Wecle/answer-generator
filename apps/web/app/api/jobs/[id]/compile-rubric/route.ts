import { answerGenerationJobs, createDb } from "@answer-generator/db";
import { eq } from "drizzle-orm";
import { compileRubricForJob } from "@/lib/rubric-compiler";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const [job] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const compiled = await compileRubricForJob({
    rubric: job.rubric,
    answerMinutes: Number(job.answerMinutes),
    passingScore: job.passingScore
  });

  const [updated] = await db
    .update(answerGenerationJobs)
    .set({
      compiledPrompt: compiled.compiledPrompt,
      rubricSchema: compiled.rubricSchema,
      status: job.status === "compiling_rubric" ? "draft" : job.status,
      updatedAt: new Date()
    })
    .where(eq(answerGenerationJobs.id, job.id))
    .returning();

  return Response.json({ jobId: updated.id, status: updated.status });
}
