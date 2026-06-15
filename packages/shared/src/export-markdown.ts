import type { GenerationItemStatus } from "./types";

interface ExportJob {
  title: string;
  rubric: string;
  items: ExportItem[];
}

interface ExportItem {
  index: number;
  title?: string | null;
  material: string | null;
  question: string;
  status: GenerationItemStatus;
  finalScore: number | null;
  finalAnswer: string | null;
}

const STATUS_LABELS: Record<GenerationItemStatus, string> = {
  pending: "待处理",
  generating: "生成中",
  reviewing: "审核中",
  passed: "通过",
  needs_review: "待人工处理",
  failed: "失败"
};

export function formatJobMarkdown(job: ExportJob): string {
  const sections = [
    `# ${job.title}`,
    "",
    "## 评分标准",
    "",
    job.rubric,
    "",
    ...job.items.flatMap(formatItem)
  ];

  return sections.join("\n").trimEnd() + "\n";
}

function formatItem(item: ExportItem): string[] {
  return [
    `## 题目 ${item.index}：${item.title?.trim() || "未命名题目"}`,
    "",
    `状态：${STATUS_LABELS[item.status]}`,
    `分数：${item.finalScore ?? "未评分"}`,
    "",
    "### 材料",
    "",
    item.material?.trim() ? item.material.trim() : "材料：无",
    "",
    "### 题目",
    "",
    item.question,
    "",
    "### 参考答案",
    "",
    item.finalAnswer?.trim() ? item.finalAnswer.trim() : "暂无答案",
    ""
  ];
}
