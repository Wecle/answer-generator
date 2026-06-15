import { answerGenerationItems, answerGenerationJobs, createDb } from "@answer-generator/db";
import { formatJobMarkdown, type GenerationItemStatus } from "@answer-generator/shared";
import { eq } from "drizzle-orm";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = createDb();
  const [job] = await db.select().from(answerGenerationJobs).where(eq(answerGenerationJobs.id, id));

  if (!job) {
    return Response.json({ error: "Job not found" }, { status: 404 });
  }

  const items = await db.select().from(answerGenerationItems).where(eq(answerGenerationItems.jobId, job.id));
  const markdown = formatJobMarkdown({
    title: job.title,
    rubric: job.rubric,
    items: items.map((item, index) => ({
      index: index + 1,
      title: item.title,
      material: item.material,
      question: item.question,
      status: item.status as GenerationItemStatus,
      finalScore: item.finalScore,
      finalAnswer: item.finalAnswer
    }))
  });

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(job.title)}.md"`
    }
  });
}
