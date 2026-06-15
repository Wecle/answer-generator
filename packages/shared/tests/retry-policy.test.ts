import { describe, expect, it } from "vitest";
import { decideReviewOutcome } from "../src/retry-policy";

describe("decideReviewOutcome", () => {
  it("passes when score reaches the configured threshold", () => {
    expect(decideReviewOutcome({ score: 96, passingScore: 95, attempt: 1, maxAttempts: 3 })).toBe("pass");
  });

  it("retries low scores while attempts remain", () => {
    expect(decideReviewOutcome({ score: 88, passingScore: 95, attempt: 2, maxAttempts: 3 })).toBe("retry");
  });

  it("sends low scores to manual review at the cap", () => {
    expect(decideReviewOutcome({ score: 91, passingScore: 95, attempt: 3, maxAttempts: 3 })).toBe("manual_review");
  });
});
