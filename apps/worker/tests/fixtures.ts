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
