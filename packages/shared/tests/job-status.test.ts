import { describe, expect, it } from "vitest";
import { shouldPollJobStatus } from "../src/job-status";

describe("shouldPollJobStatus", () => {
  it("polls jobs that can still change", () => {
    expect(shouldPollJobStatus("compiling_rubric")).toBe(true);
    expect(shouldPollJobStatus("queued")).toBe(true);
    expect(shouldPollJobStatus("running")).toBe(true);
  });

  it("stops polling terminal or editable statuses", () => {
    expect(shouldPollJobStatus("draft")).toBe(false);
    expect(shouldPollJobStatus("completed")).toBe(false);
    expect(shouldPollJobStatus("needs_review")).toBe(false);
    expect(shouldPollJobStatus("failed")).toBe(false);
    expect(shouldPollJobStatus("cancelled")).toBe(false);
  });
});
