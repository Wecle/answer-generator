import type { ReviewVerdict } from "./types";

interface DecideReviewOutcomeInput {
  score: number;
  passingScore: number;
  attempt: number;
  maxAttempts: number;
}

export function decideReviewOutcome(input: DecideReviewOutcomeInput): ReviewVerdict {
  if (input.score >= input.passingScore) {
    return "pass";
  }

  if (input.attempt >= input.maxAttempts) {
    return "manual_review";
  }

  return "retry";
}

