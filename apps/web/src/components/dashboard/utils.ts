import { z } from "zod";
import type { QuestionItem, TaskFormErrors, TaskFormState } from "./types";

export function latestReviewReasons(item: QuestionItem) {
  const reasons = item.attempts?.at(-1)?.review?.reasons ?? [];
  if (reasons.length > 0) {
    return reasons;
  }

  return item.status === "passed" ? ["该题已通过自动审核。"] : ["该题需要人工处理或继续重试。"];
}

export function statusClassName(status = "pending") {
  return status === "passed" ? "badge success" : status === "needs_review" || status === "failed" ? "badge danger" : "badge";
}

export function formatBlock(label: string, value: string, index: number) {
  const trimmed = value.trim();
  return trimmed ? `${label} ${index + 1}\n${trimmed}` : "";
}

export function formatBlocks(label: string, values: string[]) {
  return values.map((value, index) => formatBlock(label, value, index)).filter(Boolean).join("\n\n");
}

export function parseBlocks(label: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return [""];
  }

  const pattern = new RegExp(`(?:^|\\n\\n)${escapeRegExp(label)}\\s+\\d+\\n([\\s\\S]*?)(?=\\n\\n${escapeRegExp(label)}\\s+\\d+\\n|$)`, "g");
  const blocks = [...trimmed.matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean);
  return blocks.length > 0 ? blocks : [trimmed];
}

export function parseAnswerSections(answer: string) {
  const trimmed = answer.trim();
  if (!trimmed) {
    return [{ title: "参考答案", body: "" }];
  }

  const headerPattern = /^第\s*\d+\s*题\s*$/gm;
  const matches = [...trimmed.matchAll(headerPattern)];
  if (matches.length === 0) {
    return [{ title: "参考答案", body: stripAnswerLabel(trimmed) }];
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const bodyStart = start + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? trimmed.length : trimmed.length;
    return {
      title: match[0].trim(),
      body: stripAnswerLabel(trimmed.slice(bodyStart, end))
    };
  });
}

export function formatElapsed(startedAt?: string | null, completedAt?: string | null, running = false) {
  if (!startedAt) {
    return running ? "等待开始" : "未开始";
  }

  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : running ? Date.now() : start;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes} 分 ${restSeconds} 秒`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} 小时 ${restMinutes} 分`;
}

export function normalizeApiError(message: string) {
  try {
    const payload = JSON.parse(message) as { detail?: unknown };
    if (typeof payload.detail === "string") {
      return payload.detail;
    }
  } catch {
    return message;
  }

  return message;
}

export function validateTaskForm(form: TaskFormState) {
  const parsed = taskFormSchema.safeParse(form);
  const errors: TaskFormErrors = {};

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof TaskFormState | undefined;
      if (field && !errors[field]) {
        errors[field] = issue.message;
      }
    }

    return { input: null, errors };
  }

  return { input: parsed.data, errors };
}

export function statusLabel(status: string) {
  const labels: Record<string, string> = {
    compiling_rubric: "分析评分标准中",
    draft: "草稿",
    queued: "队列中",
    running: "运行中",
    completed: "已完成",
    needs_review: "待人工处理",
    failed: "失败",
    cancelled: "已停止",
    pending: "待处理",
    generating: "生成中",
    reviewing: "审核中",
    passed: "通过"
  };
  return labels[status] ?? status;
}

const taskFormSchema = z.object({
  title: z.string().trim().min(1, "请填写任务名称"),
  rubric: z.string().trim().min(1, "请填写评分标准"),
  answerMinutes: z.preprocess(
    requiredNumber,
    z.number({
      required_error: "请填写答题时间",
      invalid_type_error: "答题时间必须大于 0 分钟"
    }).positive("答题时间必须大于 0 分钟")
  ),
  passingScore: z.preprocess(
    requiredNumber,
    z.number({
      required_error: "请填写通过分数",
      invalid_type_error: "通过分数必须是 0 到 100 的整数"
    }).int("通过分数必须是 0 到 100 的整数").min(0, "通过分数必须是 0 到 100 的整数").max(100, "通过分数必须是 0 到 100 的整数")
  ),
  maxAttempts: z.preprocess(
    requiredNumber,
    z.number({
      required_error: "请填写重试次数",
      invalid_type_error: "重试次数必须是 1 到 10 的整数"
    }).int("重试次数必须是 1 到 10 的整数").min(1, "重试次数必须是 1 到 10 的整数").max(10, "重试次数必须是 1 到 10 的整数")
  )
});

function requiredNumber(value: unknown) {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  return value;
}

function stripAnswerLabel(value: string) {
  return value.trim().replace(/^参考答案\s*[：:]\s*/u, "").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
