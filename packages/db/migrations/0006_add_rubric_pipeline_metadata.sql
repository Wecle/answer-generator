ALTER TABLE "answer_generation_attempts" ADD COLUMN "prompt_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "answer_generation_jobs" ADD COLUMN "rubric_compilation" jsonb;--> statement-breakpoint
ALTER TABLE "answer_generation_reviews" ADD COLUMN "failed_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_generation_reviews" ADD COLUMN "preserved_criteria_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
