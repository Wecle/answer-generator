import { answerGenerationItems, createDb } from "@answer-generator/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

const updateItemSchema = z.object({
  title: z.string().min(1),
  material: z.string().optional(),
  question: z.string().min(1)
});

export async function PUT(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await context.params;
  const input = updateItemSchema.parse(await request.json());
  const db = createDb();
  const [item] = await db
    .update(answerGenerationItems)
    .set({
      title: input.title,
      material: input.material || null,
      question: input.question,
      updatedAt: new Date()
    })
    .where(and(eq(answerGenerationItems.id, itemId), eq(answerGenerationItems.jobId, id)))
    .returning();

  if (!item) {
    return Response.json({ error: "Item not found" }, { status: 404 });
  }

  return Response.json({ item });
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await context.params;
  const db = createDb();
  const deleted = await db
    .delete(answerGenerationItems)
    .where(and(eq(answerGenerationItems.id, itemId), eq(answerGenerationItems.jobId, id)))
    .returning({ id: answerGenerationItems.id });

  if (deleted.length === 0) {
    return Response.json({ error: "Item not found" }, { status: 404 });
  }

  return Response.json({ deleted: true });
}
