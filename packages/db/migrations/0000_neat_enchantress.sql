CREATE TYPE "public"."generation_attempt_status" AS ENUM('generated', 'reviewed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."generation_import_status" AS ENUM('uploaded', 'parsed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."generation_item_status" AS ENUM('pending', 'generating', 'reviewing', 'passed', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."generation_job_status" AS ENUM('draft', 'queued', 'running', 'completed', 'needs_review', 'failed');--> statement-breakpoint
CREATE TABLE "answer_generation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" "generation_attempt_status" DEFAULT 'generated' NOT NULL,
	"prompt_version" text DEFAULT 'v1' NOT NULL,
	"model" text NOT NULL,
	"answer" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answer_generation_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"file_name" text NOT NULL,
	"file_url" text,
	"status" "generation_import_status" DEFAULT 'uploaded' NOT NULL,
	"parsed_item_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answer_generation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"material" text,
	"question" text NOT NULL,
	"source_import_id" uuid,
	"target_min_words" integer NOT NULL,
	"target_words" integer NOT NULL,
	"target_max_words" integer NOT NULL,
	"status" "generation_item_status" DEFAULT 'pending' NOT NULL,
	"final_answer" text,
	"final_score" integer,
	"needs_manual_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answer_generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"rubric" text NOT NULL,
	"answer_minutes" numeric(4, 1) NOT NULL,
	"passing_score" integer DEFAULT 95 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"status" "generation_job_status" DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "answer_generation_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"total_score" integer NOT NULL,
	"passed" boolean NOT NULL,
	"dimensions" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"reviewer_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_generation_attempts" ADD CONSTRAINT "answer_generation_attempts_item_id_answer_generation_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."answer_generation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_generation_imports" ADD CONSTRAINT "answer_generation_imports_job_id_answer_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."answer_generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_generation_items" ADD CONSTRAINT "answer_generation_items_job_id_answer_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."answer_generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_generation_items" ADD CONSTRAINT "answer_generation_items_source_import_id_answer_generation_imports_id_fk" FOREIGN KEY ("source_import_id") REFERENCES "public"."answer_generation_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_generation_reviews" ADD CONSTRAINT "answer_generation_reviews_attempt_id_answer_generation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."answer_generation_attempts"("id") ON DELETE cascade ON UPDATE no action;