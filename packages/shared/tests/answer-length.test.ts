import { describe, expect, it } from "vitest";
import { estimateAnswerWordRange } from "../src/answer-length";

describe("estimateAnswerWordRange", () => {
  it("maps minutes to a practical Chinese interview answer range", () => {
    expect(estimateAnswerWordRange(2)).toEqual({
      minWords: 420,
      targetWords: 520,
      maxWords: 620
    });
  });

  it("clamps very short and very long durations", () => {
    expect(estimateAnswerWordRange(0.2).targetWords).toBe(260);
    expect(estimateAnswerWordRange(12).targetWords).toBe(1800);
  });
});

