import assert from "node:assert/strict";
import test from "node:test";

import { compileRubricForJob } from "../src/lib/rubric-compiler";

function fixedApiSchemaData() {
  return {
    version: "v2",
    role_prompt: "考生",
    source_requirements: [
      { id: "REQ-001", text: "准确审题", kind: "criterion" }
    ],
    global_constraints: [],
    dimensions: [
      {
        id: "DIM-001",
        name: "审题",
        max_score: 100,
        source_requirement_ids: ["REQ-001"],
        criteria: [
          {
            id: "CRI-001",
            text: "准确审题",
            source_requirement_ids: ["REQ-001"]
          }
        ],
        pitfalls: [
          {
            id: "PIT-001",
            text: "偏题",
            source_requirement_ids: ["REQ-001"]
          }
        ]
      }
    ],
    answer_principles: [],
    retry_policy: [],
    output_rules: [],
    compilation: {
      compiler_model: "compiler-model",
      auditor_model: "auditor-model",
      coverage_passed: true,
      inferred_scores: false
    }
  };
}

function normalizedApiSchemaData() {
  return {
    ...fixedApiSchemaData(),
    source_requirements: [
      { id: "REQ-001", text: "准确审题", kind: "criterion" },
      { id: "REQ-002", text: "措施闭环", kind: "criterion" },
      { id: "REQ-003", text: "有画面", kind: "score" },
      { id: "REQ-004", text: "有人味儿", kind: "score" },
      { id: "REQ-005", text: "答非所问掉档", kind: "score" },
      { id: "REQ-006", text: "超时印象分大扣", kind: "score" }
    ],
    dimensions: [
      {
        ...fixedApiSchemaData().dimensions[0],
        max_score: 40
      },
      {
        id: "DIM-002",
        name: "措施",
        max_score: 35,
        source_requirement_ids: ["REQ-002"],
        criteria: [
          {
            id: "CRI-002",
            text: "措施闭环",
            source_requirement_ids: ["REQ-002"]
          }
        ],
        pitfalls: [
          {
            id: "PIT-002",
            text: "措施脱节",
            source_requirement_ids: ["REQ-002"]
          }
        ]
      }
    ],
    scoring_policy: {
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
    }
  };
}

async function compileWithApiSchema(rubricSchema: object) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        rubric_schema: rubricSchema,
        compiler_model: "compiler-model",
        auditor_model: "auditor-model"
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  try {
    return await compileRubricForJob({
      rubric: "评分标准",
      answerMinutes: 2,
      passingScore: 95
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("converts the complete normalized scoring policy to camelCase", async () => {
  const result = await compileWithApiSchema(normalizedApiSchemaData());

  assert.deepEqual(result.rubricSchema.scoringPolicy, {
    mode: "normalized_rules",
    baseMaxScore: 75,
    bonusRules: [
      {
        id: "BONUS-001",
        text: "有画面可加2-4分",
        minScore: 2,
        maxScore: 4,
        sourceRequirementIds: ["REQ-003"]
      },
      {
        id: "BONUS-002",
        text: "有人味儿可加2-3分",
        minScore: 2,
        maxScore: 3,
        sourceRequirementIds: ["REQ-004"]
      }
    ],
    penaltyRules: [
      {
        id: "PEN-001",
        text: "答非所问掉到60-70分",
        effect: "set_range",
        score: null,
        minScore: 60,
        maxScore: 70,
        sourceRequirementIds: ["REQ-005"]
      },
      {
        id: "PEN-002",
        text: "超时印象分大扣",
        effect: "qualitative",
        score: null,
        minScore: null,
        maxScore: null,
        sourceRequirementIds: ["REQ-006"]
      }
    ],
    scoreConflicts: [
      {
        text: "档位标题与逐项上限不一致",
        sourceRequirementIds: ["REQ-003", "REQ-004"]
      }
    ],
    normalization: {
      rawMaxScore: 82,
      targetMaxScore: 100,
      method: "linear"
    }
  });
});

test("treats missing and null scoring policies as fixed-total schemas", async () => {
  const missingPolicy = await compileWithApiSchema(fixedApiSchemaData());
  const nullPolicy = await compileWithApiSchema({
    ...fixedApiSchemaData(),
    scoring_policy: null
  });

  assert.equal(missingPolicy.rubricSchema.scoringPolicy, null);
  assert.equal(nullPolicy.rubricSchema.scoringPolicy, null);
});
