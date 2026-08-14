import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeneratePayload,
  buildReviewPayload,
  toRetryFeedback
} from "../src/ai-payloads";
import { normalizedSchemaFixture, verifiedSchemaFixture } from "./fixtures";

const expectedScoringPolicy = {
  mode: "normalized_rules",
  base_max_score: 75,
  bonus_rules: [
    {
      id: "BONUS-001",
      text: "有画面可加2-4分",
      min_score: 2,
      max_score: 4,
      source_requirement_ids: ["REQ-003"]
    },
    {
      id: "BONUS-002",
      text: "有人味儿可加2-3分",
      min_score: 2,
      max_score: 3,
      source_requirement_ids: ["REQ-004"]
    }
  ],
  penalty_rules: [
    {
      id: "PEN-001",
      text: "答非所问掉到60-70分",
      effect: "set_range",
      score: null,
      min_score: 60,
      max_score: 70,
      source_requirement_ids: ["REQ-005"]
    },
    {
      id: "PEN-002",
      text: "超时印象分大扣",
      effect: "qualitative",
      score: null,
      min_score: null,
      max_score: null,
      source_requirement_ids: ["REQ-006"]
    }
  ],
  score_conflicts: [
    {
      text: "档位标题与逐项上限不一致",
      source_requirement_ids: ["REQ-003", "REQ-004"]
    }
  ],
  normalization: {
    raw_max_score: 82,
    target_max_score: 100,
    method: "linear"
  }
};

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
  assert.equal(payload.rubric_schema.scoring_policy, null);
});

test("generation and review payloads preserve normalized scoring policy", () => {
  const generatePayload = buildGeneratePayload({
    material: null,
    question: "问题",
    rubricSchema: normalizedSchemaFixture,
    answerMinutes: 2,
    targetMinWords: 420,
    targetWords: 520,
    targetMaxWords: 620,
    previousFeedback: null
  });
  const reviewPayload = buildReviewPayload({
    material: null,
    question: "问题",
    rubricSchema: normalizedSchemaFixture,
    answer: "答案",
    passingScore: 95
  });

  assert.deepEqual(
    generatePayload.rubric_schema.scoring_policy,
    expectedScoringPolicy
  );
  assert.deepEqual(
    reviewPayload.rubric_schema.scoring_policy,
    expectedScoringPolicy
  );
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
