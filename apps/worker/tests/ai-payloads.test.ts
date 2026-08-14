import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeneratePayload,
  buildReviewPayload,
  toRetryFeedback
} from "../src/ai-payloads";
import { verifiedSchemaFixture } from "./fixtures";

test("generation payload excludes raw rubric and compiled prompt", () => {
  const payload = buildGeneratePayload({
    material: null,
    question: "问题",
    rubricSchema: verifiedSchemaFixture,
    answerMinutes: 2,
    targetMinWords: 420,
    targetWords: 520,
    targetMaxWords: 620,
    previousFeedback: null
  });

  assert.equal("rubric" in payload, false);
  assert.equal("compiled_prompt" in payload, false);
  assert.equal("compiledPrompt" in payload, false);
  assert.equal(payload.target_min_words, 420);
  assert.equal(payload.target_words, 520);
  assert.equal(payload.target_max_words, 620);
  assert.equal(payload.rubric_schema.version, "v2");
});

test("review payload is schema-only and snake_case", () => {
  const payload = buildReviewPayload({
    material: "材料",
    question: "问题",
    rubricSchema: verifiedSchemaFixture,
    answer: "答案",
    passingScore: 95
  });

  assert.deepEqual(Object.keys(payload), [
    "material",
    "question",
    "rubric_schema",
    "answer",
    "passing_score"
  ]);
  assert.equal("rubric" in payload, false);
  assert.equal(payload.rubric_schema.dimensions[0]?.max_score, 50);
});

test("review feedback becomes the next generation repair payload", () => {
  const feedback = toRetryFeedback({
    failed_criteria: [
      {
        criterion_id: "CRI-002",
        reason: "缺少闭环",
        repair_instruction: "补充反馈整改"
      }
    ],
    preserved_criteria_ids: ["CRI-001"],
    reasons: ["需要形成闭环"]
  });

  assert.deepEqual(feedback, {
    failedCriteria: [
      {
        criterionId: "CRI-002",
        reason: "缺少闭环",
        repairInstruction: "补充反馈整改"
      }
    ],
    preservedCriteriaIds: ["CRI-001"],
    reasons: ["需要形成闭环"]
  });

  const payload = buildGeneratePayload({
    material: null,
    question: "问题",
    rubricSchema: verifiedSchemaFixture,
    answerMinutes: 2,
    targetMinWords: 420,
    targetWords: 520,
    targetMaxWords: 620,
    previousFeedback: feedback
  });
  assert.deepEqual(payload.previous_feedback, {
    failed_criteria: [
      {
        criterion_id: "CRI-002",
        reason: "缺少闭环",
        repair_instruction: "补充反馈整改"
      }
    ],
    preserved_criteria_ids: ["CRI-001"],
    reasons: ["需要形成闭环"]
  });
});
