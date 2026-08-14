import { expect, test } from "vitest";

import { isVerifiedRubricSchemaV2 } from "../src/rubric-schema";

function validSchemaData() {
  return {
    version: "v2",
    rolePrompt: "考生",
    sourceRequirements: [
      { id: "REQ-001", text: "准确审题", kind: "criterion" }
    ],
    globalConstraints: [],
    dimensions: [
      {
        id: "DIM-001",
        name: "审题",
        maxScore: 100,
        sourceRequirementIds: ["REQ-001"],
        criteria: [
          {
            id: "CRI-001",
            text: "准确审题",
            sourceRequirementIds: ["REQ-001"]
          }
        ],
        pitfalls: [
          {
            id: "PIT-001",
            text: "偏题",
            sourceRequirementIds: ["REQ-001"]
          }
        ]
      }
    ],
    answerPrinciples: [],
    retryPolicy: [],
    outputRules: [],
    compilation: {
      compilerModel: "test",
      auditorModel: "test",
      coveragePassed: true,
      inferredScores: false
    }
  };
}

function normalizedSchemaData() {
  return {
    ...validSchemaData(),
    sourceRequirements: [
      { id: "REQ-001", text: "准确审题", kind: "criterion" },
      { id: "REQ-002", text: "措施闭环", kind: "criterion" },
      { id: "REQ-003", text: "有画面", kind: "score" },
      { id: "REQ-004", text: "有人味儿", kind: "score" },
      { id: "REQ-005", text: "答非所问掉档", kind: "score" },
      { id: "REQ-006", text: "超时印象分大扣", kind: "score" }
    ],
    dimensions: [
      {
        ...validSchemaData().dimensions[0],
        maxScore: 40,
        sourceRequirementIds: ["REQ-001"]
      },
      {
        id: "DIM-002",
        name: "措施",
        maxScore: 35,
        sourceRequirementIds: ["REQ-002"],
        criteria: [
          {
            id: "CRI-002",
            text: "措施闭环",
            sourceRequirementIds: ["REQ-002"]
          }
        ],
        pitfalls: [
          {
            id: "PIT-002",
            text: "措施脱节",
            sourceRequirementIds: ["REQ-002"]
          }
        ]
      }
    ],
    scoringPolicy: {
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
          minScore: 60,
          maxScore: 70,
          sourceRequirementIds: ["REQ-005"]
        },
        {
          id: "PEN-002",
          text: "超时印象分大扣",
          effect: "qualitative",
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
    }
  };
}

test("accepts an audited v2 schema", () => {
  expect(isVerifiedRubricSchemaV2(validSchemaData())).toBe(true);
});

test("accepts normalized scoring rules", () => {
  expect(isVerifiedRubricSchemaV2(normalizedSchemaData())).toBe(true);
});

test("keeps missing and null scoring policies on the fixed 100-point rule", () => {
  expect(isVerifiedRubricSchemaV2(validSchemaData())).toBe(true);
  expect(
    isVerifiedRubricSchemaV2({ ...validSchemaData(), scoringPolicy: null })
  ).toBe(true);

  expect(
    isVerifiedRubricSchemaV2({
      ...validSchemaData(),
      dimensions: [{ ...validSchemaData().dimensions[0], maxScore: 75 }]
    })
  ).toBe(false);
  expect(
    isVerifiedRubricSchemaV2({
      ...validSchemaData(),
      dimensions: [{ ...validSchemaData().dimensions[0], maxScore: 75 }],
      scoringPolicy: null
    })
  ).toBe(false);
});

test("rejects invalid normalized score invariants", () => {
  const incorrectBaseTotal = normalizedSchemaData();
  incorrectBaseTotal.scoringPolicy.baseMaxScore = 74;

  const incorrectRawMax = normalizedSchemaData();
  incorrectRawMax.scoringPolicy.normalization.rawMaxScore = 81;

  const invalidBonusRange = normalizedSchemaData();
  invalidBonusRange.scoringPolicy.bonusRules[0].minScore = 5;

  const missingPenaltyField = normalizedSchemaData();
  delete missingPenaltyField.scoringPolicy.penaltyRules[0].maxScore;

  const unknownSource = normalizedSchemaData();
  unknownSource.scoringPolicy.bonusRules[0].sourceRequirementIds = ["REQ-999"];

  const duplicateRuleId = normalizedSchemaData();
  duplicateRuleId.scoringPolicy.penaltyRules[0].id = "BONUS-001";

  const oneSidedConflict = normalizedSchemaData();
  oneSidedConflict.scoringPolicy.scoreConflicts[0].sourceRequirementIds = [
    "REQ-003"
  ];

  const extraPolicyField = normalizedSchemaData() as ReturnType<
    typeof normalizedSchemaData
  > & { scoringPolicy: { unexpected?: boolean } };
  extraPolicyField.scoringPolicy.unexpected = true;

  for (const value of [
    incorrectBaseTotal,
    incorrectRawMax,
    invalidBonusRange,
    missingPenaltyField,
    unknownSource,
    duplicateRuleId,
    oneSidedConflict,
    extraPolicyField
  ]) {
    expect(isVerifiedRubricSchemaV2(value)).toBe(false);
  }
});

test("rejects v1 and unaudited schemas", () => {
  expect(
    isVerifiedRubricSchemaV2({ rolePrompt: "legacy", dimensions: [] })
  ).toBe(false);
  expect(
    isVerifiedRubricSchemaV2({
      ...validSchemaData(),
      compilation: {
        ...validSchemaData().compilation,
        coveragePassed: false
      }
    })
  ).toBe(false);
});

test("rejects malformed audited schema structures", () => {
  const malformedValues = [
    {
      ...validSchemaData(),
      compilation: { coveragePassed: true }
    },
    {
      ...validSchemaData(),
      sourceRequirements: [{}]
    },
    {
      ...validSchemaData(),
      dimensions: [{}]
    },
    {
      ...validSchemaData(),
      dimensions: [{ ...validSchemaData().dimensions[0], criteria: [] }]
    },
    {
      ...validSchemaData(),
      dimensions: [
        { ...validSchemaData().dimensions[0], sourceRequirementIds: [] }
      ]
    }
  ];

  for (const value of malformedValues) {
    expect(isVerifiedRubricSchemaV2(value)).toBe(false);
  }
});

test("rejects invalid verified-schema invariants", () => {
  const unknownReference = validSchemaData();
  unknownReference.dimensions[0].criteria[0].sourceRequirementIds = ["REQ-999"];

  const invalidTotal = validSchemaData();
  invalidTotal.dimensions[0].maxScore = 90;

  const duplicateId = validSchemaData();
  duplicateId.dimensions[0].criteria[0].id = "DIM-001";

  expect(isVerifiedRubricSchemaV2(unknownReference)).toBe(false);
  expect(isVerifiedRubricSchemaV2(invalidTotal)).toBe(false);
  expect(isVerifiedRubricSchemaV2(duplicateId)).toBe(false);
});
