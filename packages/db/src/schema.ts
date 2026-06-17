import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";

export const jobStatus = pgEnum("generation_job_status", [
  "compiling_rubric",
  "draft",
  "queued",
  "running",
  "completed",
  "needs_review",
  "failed",
  "cancelled"
]);

export const itemStatus = pgEnum("generation_item_status", [
  "pending",
  "generating",
  "reviewing",
  "passed",
  "needs_review",
  "failed"
]);

export const attemptStatus = pgEnum("generation_attempt_status", [
  "generated",
  "reviewed",
  "failed"
]);

export const importStatus = pgEnum("generation_import_status", [
  "uploaded",
  "parsed",
  "failed"
]);

export const answerGenerationJobs = pgTable("answer_generation_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  rubric: text("rubric").notNull(),
  compiledPrompt: text("compiled_prompt"),
  rubricSchema: jsonb("rubric_schema").$type<{
    rolePrompt: string;
    answerPrinciples: string[];
    dimensions: Array<{ name: string; maxScore: number; criteria: string[]; pitfalls: string[] }>;
    retryPolicy: string[];
    outputRules: string[];
  }>(),
  answerMinutes: numeric("answer_minutes", { precision: 4, scale: 1 }).notNull(),
  passingScore: integer("passing_score").notNull().default(95),
  maxAttempts: integer("max_attempts").notNull().default(3),
  status: jobStatus("status").notNull().default("draft"),
  createdBy: text("created_by"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const answerGenerationImports = pgTable("answer_generation_imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").references(() => answerGenerationJobs.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileUrl: text("file_url"),
  status: importStatus("status").notNull().default("uploaded"),
  parsedItemCount: integer("parsed_item_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const answerGenerationItems = pgTable("answer_generation_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").notNull().references(() => answerGenerationJobs.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("未命名题目"),
  material: text("material"),
  question: text("question").notNull(),
  sourceImportId: uuid("source_import_id").references(() => answerGenerationImports.id, { onDelete: "set null" }),
  targetMinWords: integer("target_min_words").notNull(),
  targetWords: integer("target_words").notNull(),
  targetMaxWords: integer("target_max_words").notNull(),
  status: itemStatus("status").notNull().default("pending"),
  finalAnswer: text("final_answer"),
  finalScore: integer("final_score"),
  needsManualReview: boolean("needs_manual_review").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const answerGenerationAttempts = pgTable("answer_generation_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").notNull().references(() => answerGenerationItems.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  status: attemptStatus("status").notNull().default("generated"),
  promptVersion: text("prompt_version").notNull().default("v1"),
  model: text("model").notNull(),
  answer: text("answer"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const answerGenerationReviews = pgTable("answer_generation_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  attemptId: uuid("attempt_id").notNull().references(() => answerGenerationAttempts.id, { onDelete: "cascade" }),
  totalScore: integer("total_score").notNull(),
  passed: boolean("passed").notNull(),
  dimensions: jsonb("dimensions").notNull().$type<Array<{ name: string; score: number; maxScore: number }>>(),
  reasons: jsonb("reasons").notNull().$type<string[]>(),
  reviewerModel: text("reviewer_model").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
