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

test("accepts an audited v2 schema", () => {
  expect(isVerifiedRubricSchemaV2(validSchemaData())).toBe(true);
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
