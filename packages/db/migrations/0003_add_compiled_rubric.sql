ALTER TABLE "answer_generation_jobs" ADD COLUMN IF NOT EXISTS "compiled_prompt" text;--> statement-breakpoint
ALTER TABLE "answer_generation_jobs" ADD COLUMN IF NOT EXISTS "rubric_schema" jsonb;--> statement-breakpoint
