import { describe, expect, it } from "vitest";
import { formatJobMarkdown } from "../src/export-markdown";

describe("formatJobMarkdown", () => {
  it("formats a generation job with item answers for administrator export", () => {
    const markdown = formatJobMarkdown({
      title: "6 月面试答案生成任务",
      rubric: "审题准确、逻辑清晰",
      items: [
        {
          index: 1,
          material: "材料内容",
          question: "请谈谈你的看法？",
          status: "passed",
          finalScore: 96,
          finalAnswer: "参考答案正文"
        }
      ]
    });

    expect(markdown).toContain("# 6 月面试答案生成任务");
    expect(markdown).toContain("## 评分标准");
    expect(markdown).toContain("审题准确、逻辑清晰");
    expect(markdown).toContain("## 题目 1");
    expect(markdown).toContain("状态：通过");
    expect(markdown).toContain("分数：96");
    expect(markdown).toContain("### 材料");
    expect(markdown).toContain("材料内容");
    expect(markdown).toContain("### 参考答案");
    expect(markdown).toContain("参考答案正文");
  });

  it("uses clear placeholders for missing material and answer", () => {
    const markdown = formatJobMarkdown({
      title: "空结果任务",
      rubric: "评分标准",
      items: [
        {
          index: 1,
          material: null,
          question: "题目",
          status: "pending",
          finalScore: null,
          finalAnswer: null
        }
      ]
    });

    expect(markdown).toContain("材料：无");
    expect(markdown).toContain("分数：未评分");
    expect(markdown).toContain("暂无答案");
  });
});
