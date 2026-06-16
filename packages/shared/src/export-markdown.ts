import type { GenerationItemStatus } from "./types";

interface ExportJob {
  title: string;
  rubric: string;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
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
    "## 任务统计",
    "",
    `耗时：${formatExportElapsed(job.startedAt, job.completedAt)}`,
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
    normalizeExportAnswer(item.finalAnswer),
    ""
  ];
}

function normalizeExportAnswer(answer: string | null): string {
  const trimmed = answer?.trim();
  if (!trimmed) {
    return "暂无答案";
  }

  const parsed = parseJsonAnswer(trimmed);
  if (!parsed) {
    return stripAnswerLabel(trimmed);
  }

  if (typeof parsed.answer === "string" && parsed.answer.trim()) {
    return stripAnswerLabel(parsed.answer);
  }
  if (typeof parsed.final_answer === "string" && parsed.final_answer.trim()) {
    return stripAnswerLabel(parsed.final_answer);
  }

  return "答案内容异常（疑似任务配置 JSON），请重新生成该题。";
}

function parseJsonAnswer(value: string): Record<string, unknown> | null {
  if (!value.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripAnswerLabel(value: string): string {
  return value.replace(/^参考答案\s*[：:]\s*/u, "").trim();
}

function formatExportElapsed(startedAt?: string | Date | null, completedAt?: string | Date | null): string {
  if (!startedAt) {
    return "未开始";
  }

  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${restSeconds} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
