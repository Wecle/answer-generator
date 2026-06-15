import { describe, expect, it } from "vitest";
import { summarizeJobProgress } from "../src/job-progress";

describe("summarizeJobProgress", () => {
  it("summarizes passed, manual review, failed, and running item counts", () => {
    expect(
      summarizeJobProgress([
        "passed",
        "passed",
        "needs_review",
        "failed",
        "generating"
      ])
    ).toEqual({
      totalItems: 5,
      passedItems: 2,
      needsReviewItems: 1,
      failedItems: 1,
      activeItems: 1,
      progressPercent: 80
    });
  });

  it("returns zero progress for empty jobs", () => {
    expect(summarizeJobProgress([])).toEqual({
      totalItems: 0,
      passedItems: 0,
      needsReviewItems: 0,
      failedItems: 0,
      activeItems: 0,
      progressPercent: 0
    });
  });
});
