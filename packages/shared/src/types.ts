export type GenerationJobStatus =
  | "compiling_rubric"
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "needs_review"
  | "failed"
  | "cancelled";

export type GenerationItemStatus =
  | "pending"
  | "generating"
  | "reviewing"
  | "passed"
  | "needs_review"
  | "failed";

export type ReviewVerdict = "pass" | "retry" | "manual_review";

export interface ReviewResult {
  totalScore: number;
  verdict: ReviewVerdict;
  reasons: string[];
}
