import type { GenerationItemStatus } from "./types";

export interface JobProgressSummary {
  totalItems: number;
  passedItems: number;
  needsReviewItems: number;
  failedItems: number;
  activeItems: number;
  progressPercent: number;
}

const ACTIVE_STATUSES = new Set<GenerationItemStatus>(["generating", "reviewing"]);
const DONE_STATUSES = new Set<GenerationItemStatus>(["passed", "needs_review", "failed"]);

export function summarizeJobProgress(statuses: GenerationItemStatus[]): JobProgressSummary {
  const totalItems = statuses.length;
  const passedItems = statuses.filter((status) => status === "passed").length;
  const needsReviewItems = statuses.filter((status) => status === "needs_review").length;
  const failedItems = statuses.filter((status) => status === "failed").length;
  const activeItems = statuses.filter((status) => ACTIVE_STATUSES.has(status)).length;
  const completedItems = statuses.filter((status) => DONE_STATUSES.has(status)).length;

  return {
    totalItems,
    passedItems,
    needsReviewItems,
    failedItems,
    activeItems,
    progressPercent: totalItems === 0 ? 0 : Math.round((completedItems / totalItems) * 100)
  };
}
