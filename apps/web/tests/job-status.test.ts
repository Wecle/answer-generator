import assert from "node:assert/strict";
import test from "node:test";
import { statusAfterSuccessfulRubricCompilation } from "../src/lib/job-status";

test("successful rubric recompilation recovers a failed job to draft", () => {
  assert.equal(statusAfterSuccessfulRubricCompilation("failed"), "draft");
  assert.equal(
    statusAfterSuccessfulRubricCompilation("compiling_rubric"),
    "draft"
  );
});

test("successful rubric compilation preserves non-failed workflow states", () => {
  assert.equal(statusAfterSuccessfulRubricCompilation("draft"), "draft");
  assert.equal(statusAfterSuccessfulRubricCompilation("completed"), "completed");
});
