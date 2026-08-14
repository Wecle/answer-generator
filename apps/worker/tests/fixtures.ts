import type { RubricSchemaV2 } from "@answer-generator/shared";

export const verifiedSchemaFixture: RubricSchemaV2 = {
  version: "v2",
  rolePrompt: "你是一名结构化面试考生。",
  sourceRequirements: [
    { id: "REQ-001", text: "准确分析问题", kind: "criterion" },
    { id: "REQ-002", text: "措施形成闭环", kind: "criterion" }
  ],
  globalConstraints: [],
  dimensions: [
    {
      id: "DIM-001",
      name: "综合分析",
      maxScore: 50,
      sourceRequirementIds: ["REQ-001"],
      criteria: [
        {
          id: "CRI-001",
          text: "准确分析问题",
          sourceRequirementIds: ["REQ-001"]
        }
      ],
      pitfalls: [
        {
          id: "PIT-001",
          text: "只表态不分析",
          sourceRequirementIds: ["REQ-001"]
        }
      ]
    },
    {
      id: "DIM-002",
      name: "解决问题",
      maxScore: 50,
      sourceRequirementIds: ["REQ-002"],
      criteria: [
        {
          id: "CRI-002",
          text: "措施形成闭环",
          sourceRequirementIds: ["REQ-002"]
        }
      ],
      pitfalls: [
        {
          id: "PIT-002",
          text: "措施缺少反馈",
          sourceRequirementIds: ["REQ-002"]
        }
      ]
    }
  ],
  answerPrinciples: ["围绕题目作答"],
  retryPolicy: ["定向修复低分项"],
  outputRules: ["输出纯文本"],
  compilation: {
    compilerModel: "test-model",
    auditorModel: "test-model",
    coveragePassed: true,
    inferredScores: false
  }
};

export const normalizedSchemaFixture: RubricSchemaV2 = {
  ...verifiedSchemaFixture,
  sourceRequirements: [
    ...verifiedSchemaFixture.sourceRequirements,
    { id: "REQ-003", text: "有画面", kind: "score" },
    { id: "REQ-004", text: "有人味儿", kind: "score" },
    { id: "REQ-005", text: "答非所问掉档", kind: "score" },
    { id: "REQ-006", text: "超时印象分大扣", kind: "score" }
  ],
  dimensions: [
    { ...verifiedSchemaFixture.dimensions[0], maxScore: 40 },
    { ...verifiedSchemaFixture.dimensions[1], maxScore: 35 }
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
