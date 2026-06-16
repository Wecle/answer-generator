"use client";

import { BadgeCheck, Download, FileUp, Play, Plus, RotateCw, Save, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { estimateAnswerWordRange, shouldPollJobStatus, type GenerationJobStatus } from "@answer-generator/shared";

interface QuestionItem {
  id: string;
  title: string;
  material: string;
  question: string;
  status?: string;
  finalAnswer?: string | null;
  finalScore?: number | null;
  attempts?: Array<{
    attemptNumber: number;
    review: {
      totalScore: number;
      passed: boolean;
      reasons: string[];
      dimensions: Array<{ name: string; score: number; maxScore: number }>;
    } | null;
  }>;
}

interface ItemFormState {
  materials: string[];
  questions: string[];
}

interface TaskFormState {
  title: string;
  rubric: string;
  answerMinutes: string;
  passingScore: string;
  maxAttempts: string;
}

type TaskFormErrors = Partial<Record<keyof TaskFormState, string>>;
type SavingAction = "create_task" | "regenerate_all" | "future_only";
type DocumentParseMode = "rules" | "ai";

interface JobSummary {
  id: string;
  title: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  progress: {
    totalItems: number;
    passedItems: number;
    needsReviewItems: number;
    failedItems: number;
    progressPercent: number;
  };
}

interface RunResponse {
  status: "passed" | "needs_review";
  final_answer: string;
  final_score: number;
  reasons: string[];
  attempts: Array<{
    attempt_number: number;
    review: {
      total_score: number;
      passed: boolean;
      reasons?: string[];
    };
  }>;
}

const initialItems: QuestionItem[] = [
  {
    id: "item-1",
    title: "政务服务质量提升",
    material: "某地推进政务服务改革，群众办事效率明显提升，但跨部门协同和数据共享仍有短板。",
    question: "请谈谈如何进一步提升政务服务质量？"
  }
];

const emptyTaskForm = {
  title: "",
  rubric: "",
  answerMinutes: "",
  passingScore: "",
  maxAttempts: ""
} satisfies TaskFormState;

const emptyQuestionForm = {
  title: "",
  materials: [""],
  questions: [""]
};

export function Dashboard() {
  const [title, setTitle] = useState("6 月面试答案生成任务");
  const [rubric, setRubric] = useState("审题准确、逻辑清晰、措施可行、群众需求、闭环管理、表达自然");
  const [answerMinutes, setAnswerMinutes] = useState(2);
  const [passingScore, setPassingScore] = useState(95);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [items, setItems] = useState<QuestionItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [itemForms, setItemForms] = useState<Record<string, ItemFormState>>({});
  const [taskForm, setTaskForm] = useState(emptyTaskForm);
  const [questionForm, setQuestionForm] = useState(emptyQuestionForm);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editTaskModalOpen, setEditTaskModalOpen] = useState(false);
  const [settingsApplyModalOpen, setSettingsApplyModalOpen] = useState(false);
  const [questionModalOpen, setQuestionModalOpen] = useState(false);
  const [deleteJobConfirmOpen, setDeleteJobConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingAction, setSavingAction] = useState<SavingAction | null>(null);
  const [pendingDocumentFile, setPendingDocumentFile] = useState<File | null>(null);
  const [documentParseModalOpen, setDocumentParseModalOpen] = useState(false);
  const [parsingDocumentMode, setParsingDocumentMode] = useState<DocumentParseMode | null>(null);
  const [documentParseError, setDocumentParseError] = useState<string | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [savedJobs, setSavedJobs] = useState<JobSummary[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobStatus, setActiveJobStatus] = useState<GenerationJobStatus>("draft");
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [taskFormErrors, setTaskFormErrors] = useState<TaskFormErrors>({});

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const selectedForm = selected
    ? itemForms[selected.id] ?? {
        materials: parseBlocks("材料", selected.material),
        questions: parseBlocks("问题", selected.question)
      }
    : null;
  const wordRange = useMemo(() => estimateAnswerWordRange(answerMinutes), [answerMinutes]);
  const dashboardStats = useMemo(() => {
    const totalTasks = savedJobs.length;
    const completedTasks = savedJobs.filter((job) => job.status === "completed").length;
    const passedItems = savedJobs.reduce((sum, job) => sum + job.progress.passedItems, 0);
    const failedItems = savedJobs.reduce((sum, job) => sum + job.progress.failedItems, 0);
    const needsReviewItems = savedJobs.reduce((sum, job) => sum + job.progress.needsReviewItems, 0);
    const totalItems = savedJobs.reduce((sum, job) => sum + job.progress.totalItems, 0);
    const reviewedItems = passedItems + failedItems + needsReviewItems;
    const successRate = reviewedItems === 0 ? 0 : Math.round((passedItems / reviewedItems) * 100);

    return {
      totalTasks,
      completedTasks,
      passedItems,
      failedItems,
      needsReviewItems,
      totalItems,
      reviewedItems,
      successRate
    };
  }, [savedJobs]);
  const persistedResult = selected?.finalAnswer
    ? {
        final_answer: selected.finalAnswer,
        final_score: selected.finalScore ?? 0,
        status: selected.status === "passed" ? "passed" : "needs_review",
        attempts: selected.attempts?.map((attempt) => ({
          attempt_number: attempt.attemptNumber,
          review: {
            total_score: attempt.review?.totalScore ?? 0,
            passed: attempt.review?.passed ?? false,
            reasons: attempt.review?.reasons ?? []
          }
        })) ?? [],
        reasons: latestReviewReasons(selected)
      } satisfies RunResponse
    : null;
  const visibleResult = selected ? result ?? persistedResult : null;
  const selectedLatestReview = selected?.attempts?.at(-1)?.review ?? null;
  const retryFeedbackAttempts =
    visibleResult?.attempts.filter((attempt) => {
      const reasons = attempt.review?.reasons ?? [];
      return attempt.review && !attempt.review.passed && reasons.length > 0;
    }) ?? [];
  const isPollingActiveJob = shouldPollJobStatus(activeJobStatus);
  const isEditingLocked = isPollingActiveJob;
  const canRestartJob = items.length > 0 && !isPollingActiveJob && activeJobStatus !== "completed";
  const restartJobLabel = activeJobStatus === "draft" ? "开始任务" : activeJobStatus === "cancelled" ? "重新开始任务" : "重新审核未通过";
  const answerSections = useMemo(() => parseAnswerSections(visibleResult?.final_answer ?? ""), [visibleResult?.final_answer]);
  const activeJobSummary = savedJobs.find((job) => job.id === activeJobId) ?? null;
  const elapsedLabel = formatElapsed(activeJobSummary?.startedAt, activeJobSummary?.completedAt, isPollingActiveJob);
  const jobProgress = useMemo(() => {
    const total = items.length;
    const terminalStatuses = new Set(["passed", "needs_review", "failed"]);
    const activeIndex = items.findIndex((item) => item.status === "generating" || item.status === "reviewing");
    const activeItem = activeIndex >= 0 ? items[activeIndex] : null;
    const completed = items.filter((item) => terminalStatuses.has(item.status ?? "pending")).length;
    const processing = items.filter((item) => item.status === "generating" || item.status === "reviewing").length;
    const passed = items.filter((item) => item.status === "passed").length;
    const needsReview = items.filter((item) => item.status === "needs_review").length;
    const percent = total === 0 ? 0 : Math.min(100, Math.round(((completed + processing * 0.5) / total) * 100));

    return {
      activeIndex,
      activeItem,
      completed,
      needsReview,
      passed,
      percent,
      total
    };
  }, [items]);

  useEffect(() => {
    void loadJobs();
  }, []);

  useEffect(() => {
    if (!activeJobId || !isPollingActiveJob) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadJobs({ silent: true });
      void loadJobDetail(activeJobId, { preserveSelection: true, silent: true });
    }, 2500);

    return () => window.clearInterval(timer);
  }, [activeJobId, isPollingActiveJob]);

  useEffect(() => {
    if (!selected) {
      return;
    }

    setItemForms((current) => {
      if (current[selected.id]) {
        return current;
      }

      return {
        ...current,
        [selected.id]: {
          materials: parseBlocks("材料", selected.material),
          questions: parseBlocks("问题", selected.question)
        }
      };
    });
  }, [selected?.id, selected?.material, selected?.question]);

  function openCreateTaskModal() {
    setTaskForm(emptyTaskForm);
    setTaskFormErrors({});
    setError(null);
    setTaskModalOpen(true);
  }

  function openEditTaskModal() {
    if (isEditingLocked) {
      setError("生成中暂不允许修改任务设置");
      return;
    }
    setTaskFormErrors({});
    setError(null);
    setTaskForm({
      title,
      rubric,
      answerMinutes: String(answerMinutes),
      passingScore: String(passingScore),
      maxAttempts: String(maxAttempts)
    });
    setEditTaskModalOpen(true);
  }

  function updateTaskFormField(field: keyof TaskFormState, value: string) {
    setTaskForm((current) => ({ ...current, [field]: value }));
    setTaskFormErrors((current) => {
      if (!current[field]) {
        return current;
      }
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function updateSelected(patch: Partial<QuestionItem>) {
    if (isEditingLocked) return;
    if (!selected) return;
    setItems((current) => current.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)));
  }

  function updateSelectedMaterials(materials: string[]) {
    if (isEditingLocked) return;
    if (!selected) return;
    setItemForms((current) => ({
      ...current,
      [selected.id]: {
        materials,
        questions: current[selected.id]?.questions ?? parseBlocks("问题", selected.question)
      }
    }));
    updateSelected({ material: formatBlocks("材料", materials) });
  }

  function updateSelectedQuestions(questions: string[]) {
    if (isEditingLocked) return;
    if (!selected) return;
    setItemForms((current) => ({
      ...current,
      [selected.id]: {
        materials: current[selected.id]?.materials ?? parseBlocks("材料", selected.material),
        questions
      }
    }));
    updateSelected({ question: formatBlocks("问题", questions) });
  }

  async function createJob() {
    setError(null);
    const { input, errors } = validateTaskForm(taskForm);
    setTaskFormErrors(errors);
    if (!input) return;
    setSaving(true);
    setSavingAction("create_task");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, items: [] })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const payload = (await response.json()) as { jobId: string };
      setActiveJobId(payload.jobId);
      setActiveJobStatus("draft");
      setTitle(input.title);
      setRubric(input.rubric);
      setAnswerMinutes(input.answerMinutes);
      setPassingScore(input.passingScore);
      setMaxAttempts(input.maxAttempts);
      setItems([]);
      setSelectedId("");
      setItemForms({});
      setTaskModalOpen(false);
      await loadJobs();
      await loadJobDetail(payload.jobId, { preserveSelection: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
      setSavingAction(null);
    }
  }

  function requestUpdateJobSettings() {
    if (isEditingLocked) {
      setError("生成中暂不允许修改任务设置");
      return;
    }
    setError(null);
    const { input, errors } = validateTaskForm(taskForm);
    setTaskFormErrors(errors);
    if (!input) return;
    setEditTaskModalOpen(false);
    setSettingsApplyModalOpen(true);
  }

  async function updateJobSettings(applyMode: "regenerate_all" | "future_only") {
    if (!activeJobId) return;
    if (isEditingLocked) {
      setError("生成中暂不允许修改任务设置");
      return;
    }
    setError(null);
    const { input, errors } = validateTaskForm(taskForm);
    setTaskFormErrors(errors);
    if (!input) return;
    setSaving(true);
    setSavingAction(applyMode);
    try {
      const response = await fetch(`/api/jobs/${activeJobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, applyMode })
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setTitle(input.title);
      setRubric(input.rubric);
      setAnswerMinutes(input.answerMinutes);
      setPassingScore(input.passingScore);
      setMaxAttempts(input.maxAttempts);
      setResult(null);
      setSettingsApplyModalOpen(false);
      await loadJobs();
      await loadJobDetail(activeJobId, { preserveSelection: applyMode === "future_only" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改任务设置失败");
    } finally {
      setSaving(false);
      setSavingAction(null);
    }
  }

  function handleDocumentFile(file: File | null) {
    if (!file) return;
    if (!activeJobId) {
      setError("请先新增任务");
      return;
    }
    if (isEditingLocked) {
      setError("生成中暂不允许新增或修改题目");
      return;
    }
    setError(null);
    setDocumentParseError(null);
    setPendingDocumentFile(file);
    setDocumentParseModalOpen(true);
  }

  async function parseDocument(mode: DocumentParseMode) {
    if (!pendingDocumentFile) return;
    if (isEditingLocked) {
      setDocumentParseError("生成中暂不允许新增或修改题目");
      return;
    }
    const form = new FormData();
    form.append("file", pendingDocumentFile);
    form.append("mode", mode);
    setParsingDocumentMode(mode);
    setDocumentParseError(null);
    try {
      const response = await fetch("/api/documents/parse", { method: "POST", body: form });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const payload = (await response.json()) as { questions: Array<{ title?: string | null; material?: string | null; question: string }> };
      const parsed = payload.questions.map((question, index) => ({
        title: question.title?.trim() || `Word 题目 ${index + 1}`,
        material: question.material ?? "",
        question: question.question
      }));
      if (parsed.length > 0) {
        await appendItems(parsed);
        setResult(null);
      }
      setDocumentParseModalOpen(false);
      setPendingDocumentFile(null);
    } catch (err) {
      setDocumentParseError(err instanceof Error ? normalizeApiError(err.message) : "解析失败");
    } finally {
      setParsingDocumentMode(null);
    }
  }

  async function appendItems(nextItems: Array<{ title: string; material: string; question: string }>, options?: { focusNewItem?: boolean }) {
    if (!activeJobId) {
      setError("请先新增任务");
      return;
    }
    if (isEditingLocked) {
      setError("生成中暂不允许新增或修改题目");
      return;
    }

    const response = await fetch(`/api/jobs/${activeJobId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: nextItems })
    });

    if (!response.ok) {
      setError(await response.text());
      return;
    }

    const payload = (await response.json()) as { items: Array<{ id: string }> };
    await loadJobDetail(activeJobId, { focusItemId: options?.focusNewItem ? payload.items[0]?.id : undefined, preserveSelection: true });
    await loadJobs();
  }

  async function addQuestionFromModal() {
    if (isEditingLocked) {
      setError("生成中暂不允许新增或修改题目");
      return;
    }
    const material = questionForm.materials.map((value, index) => formatBlock("材料", value, index)).filter(Boolean).join("\n\n");
    const question = questionForm.questions.map((value, index) => formatBlock("问题", value, index)).filter(Boolean).join("\n\n");

    if (!question.trim()) {
      setError("请至少填写一个问题");
      return;
    }

    await appendItems([
      {
        title: questionForm.title.trim() || "未命名题目",
        material,
        question
      }
    ], { focusNewItem: true });
    setQuestionForm(emptyQuestionForm);
    setQuestionModalOpen(false);
  }

  async function loadJobs(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setLoadingJobs(true);
    }
    try {
      const response = await fetch("/api/jobs");
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { jobs: JobSummary[] };
      setSavedJobs(payload.jobs);
    } finally {
      if (!options?.silent) {
        setLoadingJobs(false);
      }
    }
  }

  async function loadJobDetail(jobId: string, options?: { preserveSelection?: boolean; silent?: boolean; focusItemId?: string }) {
    if (!options?.silent) {
      setError(null);
    }
    const response = await fetch(`/api/jobs/${jobId}`);
    if (!response.ok) {
      if (!options?.silent) {
        setError(await response.text());
      }
      return;
    }
    const payload = (await response.json()) as {
      job: {
        id: string;
        title: string;
        rubric: string;
        answerMinutes: string;
        passingScore: number;
        maxAttempts: number;
        status: GenerationJobStatus;
        startedAt: string | null;
        completedAt: string | null;
      };
      items: Array<{
        id: string;
        title: string;
        material: string | null;
        question: string;
        status: string;
        finalAnswer: string | null;
        finalScore: number | null;
        attempts: Array<{
          attemptNumber: number;
          review: {
            totalScore: number;
            passed: boolean;
            reasons: string[];
            dimensions: Array<{ name: string; score: number; maxScore: number }>;
          } | null;
        }>;
      }>;
    };

    setActiveJobId(payload.job.id);
    setActiveJobStatus(payload.job.status);
    setTitle(payload.job.title);
    setRubric(payload.job.rubric);
    setAnswerMinutes(Number(payload.job.answerMinutes));
    setPassingScore(payload.job.passingScore);
    setMaxAttempts(payload.job.maxAttempts);
    const loadedItems = payload.items.map((item) => ({
      id: item.id,
      title: item.title,
      material: item.material ?? "",
      question: item.question,
      status: item.status,
      finalAnswer: item.finalAnswer,
      finalScore: item.finalScore,
      attempts: item.attempts
    }));
    setItems(loadedItems);
    setSelectedId((current) => {
      if (options?.focusItemId && loadedItems.some((item) => item.id === options.focusItemId)) {
        return options.focusItemId;
      }
      if (options?.preserveSelection && loadedItems.some((item) => item.id === current)) {
        return current;
      }
      return "";
    });
    setResult(null);
  }

  async function runSavedJob() {
    if (!activeJobId) {
      openCreateTaskModal();
      return;
    }

    setError(null);
    const response = await fetch(`/api/jobs/${activeJobId}/run`, { method: "POST" });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const payload = (await response.json()) as { workerOnline?: boolean };
    setEditTaskModalOpen(false);
    setSettingsApplyModalOpen(false);
    setQuestionModalOpen(false);
    setDocumentParseModalOpen(false);
    setPendingDocumentFile(null);
    setActiveJobStatus("queued");
    await loadJobs();
    await loadJobDetail(activeJobId, { preserveSelection: true });
    if (payload.workerOnline === false) {
      setError("Worker 未启动，任务已进入队列。请启动 pnpm --filter @answer-generator/worker dev 后继续。");
    }
  }

  async function stopJob() {
    if (!activeJobId) return;
    setError(null);
    const response = await fetch(`/api/jobs/${activeJobId}/stop`, { method: "POST" });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    setActiveJobStatus("cancelled");
    await loadJobs();
    await loadJobDetail(activeJobId, { preserveSelection: true });
  }

  async function deleteJob() {
    if (!activeJobId) return;
    setError(null);
    const response = await fetch(`/api/jobs/${activeJobId}`, { method: "DELETE" });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    setActiveJobId(null);
    setActiveJobStatus("draft");
    setItems([]);
    setSelectedId("");
    setItemForms({});
    setResult(null);
    setDeleteJobConfirmOpen(false);
    await loadJobs();
  }

  async function saveSelectedItem() {
    if (!activeJobId || !selected) return;
    if (isEditingLocked) {
      setError("生成中暂不允许修改题目");
      return;
    }
    if (!selected.question.trim()) {
      setError("请至少保留一个问题");
      return;
    }
    setSavingItem(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${activeJobId}/items/${selected.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: selected.title || "未命名题目",
          material: selected.material,
          question: selected.question
        })
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      await loadJobDetail(activeJobId, { preserveSelection: true });
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存题目失败");
    } finally {
      setSavingItem(false);
    }
  }

  async function deleteSelectedItem() {
    if (!activeJobId || !selected) return;
    if (isEditingLocked) {
      setError("生成中暂不允许删除题目");
      return;
    }
    setError(null);
    const response = await fetch(`/api/jobs/${activeJobId}/items/${selected.id}`, { method: "DELETE" });
    if (!response.ok) {
      setError(await response.text());
      return;
    }

    await loadJobDetail(activeJobId);
    setItemForms((current) => {
      const next = { ...current };
      delete next[selected.id];
      return next;
    });
    await loadJobs();
  }

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">AG</span>
          <span>Answer Generator</span>
        </div>
        <button className="button new-task-button" type="button" onClick={openCreateTaskModal}>
          <Plus size={16} />
          新增任务
        </button>
        <div className="saved-jobs">
          <div className="saved-jobs-head">
            <span>任务列表</span>
            <button type="button" onClick={() => loadJobs()} disabled={loadingJobs}>
              <RotateCw size={14} />
            </button>
          </div>
          <div className="saved-jobs-list">
            {savedJobs.length ? (
              savedJobs.slice(0, 6).map((job) => {
                const jobRunning = shouldPollJobStatus(job.status as GenerationJobStatus);
                return (
                  <button
                    className={job.id === activeJobId ? "saved-job active" : "saved-job"}
                    key={job.id}
                    type="button"
                    onClick={() => loadJobDetail(job.id)}
                  >
                    <strong>{job.title}</strong>
                    <span className="saved-job-status">
                      {jobRunning ? <span className="saved-job-spinner" aria-hidden="true" /> : null}
                      <span>{statusLabel(job.status)} · {job.progress.progressPercent}%</span>
                    </span>
                    <span>{formatElapsed(job.startedAt, job.completedAt, jobRunning)}</span>
                    <span className="saved-job-bar" aria-hidden="true">
                      <i style={{ width: `${job.progress.progressPercent}%` }} />
                    </span>
                  </button>
                );
              })
            ) : (
              <span className="empty-list">{loadingJobs ? "加载中" : "暂无保存任务"}</span>
            )}
          </div>
        </div>
      </aside>

      <section className="workspace">
        {activeJobId ? <div className="toolbar">
          <div className="toolbar-copy">
            <h2>{title}</h2>
            {items.length > 0 ? (
              <div className="job-progress">
                <div className="job-progress-head">
                  <span>
                    {jobProgress.activeItem
                      ? `${jobProgress.activeItem.status === "reviewing" ? "当前正在审核" : "当前正在生成"}：${jobProgress.activeItem.title || `题目 ${jobProgress.activeIndex + 1}`}`
                      : isPollingActiveJob
                        ? "等待 Worker 接收任务"
                        : statusLabel(activeJobStatus)}
                  </span>
                  <strong>{jobProgress.percent}%</strong>
                </div>
                <div className="job-progress-bar" aria-label={`任务进度 ${jobProgress.percent}%`}>
                  <i style={{ width: `${jobProgress.percent}%` }} />
                </div>
                <div className="job-progress-meta">
                  <span>已处理 {jobProgress.completed}/{jobProgress.total}</span>
                  <span>已通过 {jobProgress.passed}</span>
                  <span>待人工 {jobProgress.needsReview}</span>
                  <span>耗时 {elapsedLabel}</span>
                </div>
              </div>
            ) : null}
          </div>
          <div className="top-actions">
            {!isEditingLocked ? (
              <button className="button secondary" type="button" onClick={openEditTaskModal}>
                <Settings size={16} />
                修改设置
              </button>
            ) : null}
            <label className={isEditingLocked ? "button secondary disabled" : "button secondary"} aria-disabled={isEditingLocked}>
              <FileUp size={16} />
              上传 Word
              <input
                hidden
                type="file"
                accept=".docx"
                disabled={isEditingLocked}
                onChange={(event) => {
                  handleDocumentFile(event.target.files?.[0] ?? null);
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <button className="button secondary" type="button" onClick={() => setQuestionModalOpen(true)} disabled={isEditingLocked}>
              <Plus size={16} />
              新增题目
            </button>
            {items.length > 0 ? (
              <>
                {canRestartJob ? (
                  <button className="button" type="button" onClick={runSavedJob}>
                    <Play size={16} />
                    {restartJobLabel}
                  </button>
                ) : null}
                {isPollingActiveJob ? (
                  <button className="button secondary" type="button" onClick={stopJob}>
                    <RotateCw size={16} />
                    停止
                  </button>
                ) : null}
                <button className="button secondary danger-action" type="button" onClick={() => setDeleteJobConfirmOpen(true)}>
                  删除
                </button>
                <a className="button secondary" href={`/api/jobs/${activeJobId}/export`}>
                  <Download size={16} />
                  导出结果
                </a>
              </>
            ) : null}
          </div>
        </div> : null}

        {error ? <div className="error">{error}</div> : null}

        {!activeJobId ? (
          <section className="dashboard-home">
            <div className="panel-title">
              <h3>仪表盘</h3>
              <span>任务概览</span>
            </div>
            <div className="dashboard-cards">
              <div className="dashboard-card">
                <strong>{dashboardStats.totalTasks}</strong>
                <span>任务总数</span>
              </div>
              <div className="dashboard-card">
                <strong>{dashboardStats.totalItems}</strong>
                <span>题目总数</span>
              </div>
              <div className="dashboard-card">
                <strong>{dashboardStats.reviewedItems}</strong>
                <span>审核总数</span>
              </div>
              <div className="dashboard-card">
                <strong>{dashboardStats.passedItems}</strong>
                <span>审核成功</span>
              </div>
              <div className="dashboard-card">
                <strong>{dashboardStats.completedTasks}</strong>
                <span>已完成任务</span>
              </div>
              <div className="dashboard-card">
                <strong>{dashboardStats.failedItems}</strong>
                <span>失败题目</span>
              </div>
              <div className="dashboard-card">
                <strong>{dashboardStats.needsReviewItems}</strong>
                <span>待人工处理</span>
              </div>
              <div className="dashboard-card wide">
                <strong>{dashboardStats.successRate}%</strong>
                <span>审核成功率</span>
              </div>
            </div>
          </section>
        ) : (
        <>
        {items.length > 0 ? <div className={selected ? "task-layout" : "task-layout queue-only"}>
          <section className="panel queue-panel">
            <div className="panel-title">
              <h3>题目队列</h3>
              <div className="queue-title-actions">
                <span>{isPollingActiveJob ? "自动刷新中" : `${items.length} 题`}</span>
                <button className="button secondary small" type="button" onClick={() => setQuestionModalOpen(true)} disabled={isEditingLocked}>
                  <Plus size={14} />
                  新增题目
                </button>
              </div>
            </div>
            <div className="items">
              {items.map((item, index) => (
                <button
                  className={item.id === selected?.id ? "item active" : "item"}
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id);
                    setResult(null);
                  }}
                >
                  <div className="item-head">
                    <strong>{item.title || `题目 ${index + 1}`}</strong>
                    <span className={statusClassName(item.status)}>{item.id === selected?.id ? (isEditingLocked ? "查看中" : "编辑中") : statusLabel(item.status ?? "pending")}</span>
                  </div>
                  <span className="item-copy">{item.question || "空题目"}</span>
                  <span className="item-meta">
                    {item.finalScore === null || item.finalScore === undefined ? "未评分" : `${item.finalScore} 分`}
                    {" · "}
                    {item.attempts?.length ?? 0} 次尝试
                  </span>
                </button>
              ))}
            </div>
          </section>
          {selected ? <section className="panel active-question-panel" key={selected.id}>
            <div className="panel-title">
              <h3>当前题目</h3>
              <span>{isEditingLocked ? "生成中只读" : `${wordRange.minWords}-${wordRange.maxWords} 字`}</span>
            </div>
            <div className="field">
              <label htmlFor="question-title">题目名称</label>
              <input id="question-title" value={selected.title} disabled={isEditingLocked} onChange={(event) => updateSelected({ title: event.target.value })} />
            </div>
            <RepeatableFields
              label="材料"
              values={selectedForm?.materials ?? [""]}
              onChange={updateSelectedMaterials}
              disabled={isEditingLocked}
            />
            <RepeatableFields
              label="问题"
              values={selectedForm?.questions ?? [""]}
              onChange={updateSelectedQuestions}
              disabled={isEditingLocked}
            />
            <div className="actions item-actions">
              <button className="button secondary" type="button" onClick={saveSelectedItem} disabled={savingItem || isEditingLocked}>
                <Save size={16} />
                {savingItem ? "保存中" : "保存题目"}
              </button>
              <button className="button secondary danger-action" type="button" onClick={deleteSelectedItem} disabled={isEditingLocked}>
                删除题目
              </button>
            </div>
          </section> : null}

          {selected ? <section className="panel active-question-panel result-panel" key={`${selected.id}-result`}>
            <div className="panel-title">
              <h3>生成结果</h3>
              <span>{statusLabel(selected?.status ?? (result ? result.status : "pending"))}</span>
            </div>
            {visibleResult ? (
              <>
                <div className="result-sections">
                  {answerSections.map((section, index) => (
                    <article className="result-section" key={`${section.title}-${index}`}>
                      <div className="result-section-head">
                        <span>{section.title}</span>
                      </div>
                      <div className="result">{section.body}</div>
                    </article>
                  ))}
                </div>
                <div className="review">
                  <div className="review-box">
                    <strong>{visibleResult.final_score}</strong>
                    <span>最终得分</span>
                  </div>
                  <div className="review-box">
                    <strong>{visibleResult.attempts.length}</strong>
                    <span>尝试次数</span>
                  </div>
                  <div className="review-box">
                    <strong className="review-status">
                      {visibleResult.status === "passed" ? <BadgeCheck size={22} /> : <RotateCw size={22} />}
                      {visibleResult.status === "passed" ? "通过" : "人工处理"}
                    </strong>
                    <span>审核状态</span>
                  </div>
                </div>
                {retryFeedbackAttempts.length > 0 ? (
                  <div className="retry-notes">
                    <h4>重试意见</h4>
                    {retryFeedbackAttempts.map((attempt) => (
                      <div className="retry-note" key={attempt.attempt_number}>
                        <div className="retry-note-head">
                          <strong>第 {attempt.attempt_number} 轮</strong>
                          <span>{attempt.review.total_score} 分</span>
                        </div>
                        <div className="retry-note-reasons">
                          {attempt.review.reasons?.map((reason) => (
                            <p key={reason}>{reason}</p>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {selectedLatestReview?.dimensions.length ? (
                  <div className="dimensions">
                    {selectedLatestReview.dimensions.map((dimension) => (
                      <div className="dimension" key={dimension.name}>
                        <span>{dimension.name}</span>
                        <strong>
                          {dimension.score}/{dimension.maxScore}
                        </strong>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="result empty">自动审核完成后显示结果。</div>
            )}
          </section> : null}
        </div> : (
          <section className="empty-queue-state">
            <span>题目队列为空</span>
            <p>等待导入题目材料，生成流程会在题目加入后开始准备。</p>
          </section>
        )}
        </>
        )}
      </section>
      {taskModalOpen ? (
        <div className="modal-backdrop">
          <section className="modal">
            <div className="panel-title">
              <h3>新增任务</h3>
              <button className="icon-button" type="button" onClick={() => setTaskModalOpen(false)}>×</button>
            </div>
            <div className="field">
              <label htmlFor="task-title">任务名称</label>
              <input id="task-title" value={taskForm.title} aria-invalid={Boolean(taskFormErrors.title)} onChange={(event) => updateTaskFormField("title", event.target.value)} />
              <FieldError message={taskFormErrors.title} />
            </div>
            <div className="field">
              <label htmlFor="task-rubric">评分标准</label>
              <textarea id="task-rubric" value={taskForm.rubric} aria-invalid={Boolean(taskFormErrors.rubric)} onChange={(event) => updateTaskFormField("rubric", event.target.value)} />
              <FieldError message={taskFormErrors.rubric} />
            </div>
            <div className="rubric-preview">
              <div className="rubric-preview-head">评分标准预览</div>
              <MarkdownPreview value={taskForm.rubric} />
            </div>
            <div className="split">
              <div className="field">
                <label htmlFor="task-minutes">答题时间</label>
                <input id="task-minutes" type="number" min="1" step="0.5" value={taskForm.answerMinutes} aria-invalid={Boolean(taskFormErrors.answerMinutes)} onChange={(event) => updateTaskFormField("answerMinutes", event.target.value)} />
                <FieldError message={taskFormErrors.answerMinutes} />
              </div>
              <div className="field">
                <label htmlFor="task-score">通过分数</label>
                <input id="task-score" type="number" min="0" max="100" value={taskForm.passingScore} aria-invalid={Boolean(taskFormErrors.passingScore)} onChange={(event) => updateTaskFormField("passingScore", event.target.value)} />
                <FieldError message={taskFormErrors.passingScore} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="task-attempts">重试次数</label>
              <input id="task-attempts" type="number" min="1" max="10" value={taskForm.maxAttempts} aria-invalid={Boolean(taskFormErrors.maxAttempts)} onChange={(event) => updateTaskFormField("maxAttempts", event.target.value)} />
              <FieldError message={taskFormErrors.maxAttempts} />
            </div>
            <div className="actions">
              <button className="button" type="button" onClick={createJob} disabled={saving}>
                <LoadingLabel loading={savingAction === "create_task"} loadingText="创建中" text="创建任务" />
              </button>
              <button className="button secondary" type="button" onClick={() => setTaskModalOpen(false)}>取消</button>
            </div>
          </section>
        </div>
      ) : null}
      {editTaskModalOpen ? (
        <div className="modal-backdrop">
          <section className="modal">
            <div className="panel-title">
              <h3>修改任务设置</h3>
              <button className="icon-button" type="button" onClick={() => setEditTaskModalOpen(false)}>×</button>
            </div>
            <div className="field">
              <label htmlFor="edit-task-title">任务名称</label>
              <input id="edit-task-title" value={taskForm.title} aria-invalid={Boolean(taskFormErrors.title)} onChange={(event) => updateTaskFormField("title", event.target.value)} />
              <FieldError message={taskFormErrors.title} />
            </div>
            <div className="field">
              <label htmlFor="edit-task-rubric">评分标准</label>
              <textarea id="edit-task-rubric" value={taskForm.rubric} aria-invalid={Boolean(taskFormErrors.rubric)} onChange={(event) => updateTaskFormField("rubric", event.target.value)} />
              <FieldError message={taskFormErrors.rubric} />
            </div>
            <div className="rubric-preview">
              <div className="rubric-preview-head">评分标准预览</div>
              <MarkdownPreview value={taskForm.rubric} />
            </div>
            <div className="split">
              <div className="field">
                <label htmlFor="edit-task-minutes">答题时间</label>
                <input id="edit-task-minutes" type="number" min="1" step="0.5" value={taskForm.answerMinutes} aria-invalid={Boolean(taskFormErrors.answerMinutes)} onChange={(event) => updateTaskFormField("answerMinutes", event.target.value)} />
                <FieldError message={taskFormErrors.answerMinutes} />
              </div>
              <div className="field">
                <label htmlFor="edit-task-score">通过分数</label>
                <input id="edit-task-score" type="number" min="0" max="100" value={taskForm.passingScore} aria-invalid={Boolean(taskFormErrors.passingScore)} onChange={(event) => updateTaskFormField("passingScore", event.target.value)} />
                <FieldError message={taskFormErrors.passingScore} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="edit-task-attempts">重试次数</label>
              <input id="edit-task-attempts" type="number" min="1" max="10" value={taskForm.maxAttempts} aria-invalid={Boolean(taskFormErrors.maxAttempts)} onChange={(event) => updateTaskFormField("maxAttempts", event.target.value)} />
              <FieldError message={taskFormErrors.maxAttempts} />
            </div>
            <div className="actions">
              <button className="button" type="button" onClick={requestUpdateJobSettings}>确认修改</button>
              <button className="button secondary" type="button" onClick={() => setEditTaskModalOpen(false)}>取消</button>
            </div>
          </section>
        </div>
      ) : null}
      {settingsApplyModalOpen ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal settings-confirm-modal">
            <div className="panel-title">
              <h3>应用新设置</h3>
              <button className="icon-button" type="button" onClick={() => setSettingsApplyModalOpen(false)}>×</button>
            </div>
            <p className="confirm-copy">请选择新设置的应用范围。重新生成会清空所有题目的生成结果和审核记录。</p>
            <div className="settings-confirm-actions">
              <button className="button danger-button" type="button" onClick={() => updateJobSettings("regenerate_all")} disabled={saving}>
                <LoadingLabel loading={savingAction === "regenerate_all"} loadingText="处理中" text="全部题目重新生成" />
              </button>
              <button className="button secondary" type="button" onClick={() => updateJobSettings("future_only")} disabled={saving}>
                <LoadingLabel loading={savingAction === "future_only"} loadingText="处理中" text="仅未生成题目使用新设置" />
              </button>
              <button className="button secondary" type="button" onClick={() => setSettingsApplyModalOpen(false)} disabled={saving}>
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {documentParseModalOpen ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal document-parse-modal">
            <div className="panel-title">
              <h3>选择解析方式</h3>
              <button
                className="icon-button"
                type="button"
                onClick={() => {
                  if (parsingDocumentMode) return;
                  setDocumentParseModalOpen(false);
                  setPendingDocumentFile(null);
                }}
              >
                ×
              </button>
            </div>
            <p className="confirm-copy">
              {pendingDocumentFile?.name ?? "Word 文档"} 已选择。普通解析适合格式规整的文档，AI 解析适合题目、材料和问题排版差异较大的文档。
            </p>
            {documentParseError ? <p className="modal-error">{documentParseError}</p> : null}
            <div className="settings-confirm-actions">
              <button className="button" type="button" onClick={() => parseDocument("rules")} disabled={Boolean(parsingDocumentMode)}>
                <LoadingLabel loading={parsingDocumentMode === "rules"} loadingText="解析中" text="普通解析" />
              </button>
              <button className="button secondary" type="button" onClick={() => parseDocument("ai")} disabled={Boolean(parsingDocumentMode)}>
                <LoadingLabel loading={parsingDocumentMode === "ai"} loadingText="解析中" text="AI 解析" />
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setDocumentParseModalOpen(false);
                  setPendingDocumentFile(null);
                }}
                disabled={Boolean(parsingDocumentMode)}
              >
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {questionModalOpen ? (
        <div className="modal-backdrop">
          <section className="modal">
            <div className="panel-title">
              <h3>新增题目</h3>
              <button className="icon-button" type="button" onClick={() => setQuestionModalOpen(false)}>×</button>
            </div>
            <div className="field">
              <label htmlFor="new-question-title">题目名称</label>
              <input id="new-question-title" value={questionForm.title} disabled={isEditingLocked} onChange={(event) => setQuestionForm({ ...questionForm, title: event.target.value })} />
            </div>
            <RepeatableFields
              label="材料"
              values={questionForm.materials}
              onChange={(materials) => setQuestionForm((current) => ({ ...current, materials }))}
              disabled={isEditingLocked}
            />
            <RepeatableFields
              label="问题"
              values={questionForm.questions}
              onChange={(questions) => setQuestionForm((current) => ({ ...current, questions }))}
              disabled={isEditingLocked}
            />
            <div className="actions">
              <button className="button" type="button" onClick={addQuestionFromModal} disabled={isEditingLocked}>添加题目</button>
              <button className="button secondary" type="button" onClick={() => setQuestionModalOpen(false)}>取消</button>
            </div>
          </section>
        </div>
      ) : null}
      {deleteJobConfirmOpen ? (
        <div className="modal-backdrop">
          <section className="modal confirm-modal">
            <div className="panel-title">
              <h3>删除任务</h3>
              <button className="icon-button" type="button" onClick={() => setDeleteJobConfirmOpen(false)}>×</button>
            </div>
            <p className="confirm-copy">删除后会同时移除该任务下的题目、生成尝试和审核结果。</p>
            <div className="actions">
              <button className="button secondary danger-action" type="button" onClick={deleteJob}>确认删除</button>
              <button className="button" type="button" onClick={() => setDeleteJobConfirmOpen(false)}>取消</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function latestReviewReasons(item: QuestionItem) {
  const reasons = item.attempts?.at(-1)?.review?.reasons ?? [];
  if (reasons.length > 0) {
    return reasons;
  }

  return item.status === "passed" ? ["该题已通过自动审核。"] : ["该题需要人工处理或继续重试。"];
}

function statusClassName(status = "pending") {
  return status === "passed" ? "badge success" : status === "needs_review" || status === "failed" ? "badge danger" : "badge";
}

function formatBlock(label: string, value: string, index: number) {
  const trimmed = value.trim();
  return trimmed ? `${label} ${index + 1}\n${trimmed}` : "";
}

function formatBlocks(label: string, values: string[]) {
  return values.map((value, index) => formatBlock(label, value, index)).filter(Boolean).join("\n\n");
}

function parseBlocks(label: string, value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return [""];
  }

  const pattern = new RegExp(`(?:^|\\n\\n)${escapeRegExp(label)}\\s+\\d+\\n([\\s\\S]*?)(?=\\n\\n${escapeRegExp(label)}\\s+\\d+\\n|$)`, "g");
  const blocks = [...trimmed.matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean);
  return blocks.length > 0 ? blocks : [trimmed];
}

function parseAnswerSections(answer: string) {
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

function stripAnswerLabel(value: string) {
  return value.trim().replace(/^参考答案\s*[：:]\s*/u, "").trim();
}

function formatElapsed(startedAt?: string | null, completedAt?: string | null, running = false) {
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

function normalizeApiError(message: string) {
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

function validateTaskForm(form: TaskFormState) {
  const title = form.title.trim();
  const rubric = form.rubric.trim();
  const answerMinutes = Number(form.answerMinutes);
  const passingScore = Number(form.passingScore);
  const maxAttempts = Number(form.maxAttempts);
  const errors: TaskFormErrors = {};

  if (!title) errors.title = "请填写任务名称";
  if (!rubric) errors.rubric = "请填写评分标准";
  if (!form.answerMinutes.trim()) errors.answerMinutes = "请填写答题时间";
  if (!form.passingScore.trim()) errors.passingScore = "请填写通过分数";
  if (!form.maxAttempts.trim()) errors.maxAttempts = "请填写重试次数";

  if (!errors.answerMinutes && (!Number.isFinite(answerMinutes) || answerMinutes <= 0)) {
    errors.answerMinutes = "答题时间必须大于 0 分钟";
  }
  if (!errors.passingScore && (!Number.isInteger(passingScore) || passingScore < 0 || passingScore > 100)) {
    errors.passingScore = "通过分数必须是 0 到 100 的整数";
  }
  if (!errors.maxAttempts && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) {
    errors.maxAttempts = "重试次数必须是 1 到 10 的整数";
  }

  if (Object.keys(errors).length > 0) {
    return { input: null, errors };
  }

  return { input: { title, rubric, answerMinutes, passingScore, maxAttempts }, errors };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function RepeatableFields({
  label,
  values,
  onChange,
  disabled = false
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="repeatable">
      <div className="repeatable-head">
        <span>{label}</span>
        <button className="button secondary small" type="button" onClick={() => onChange([...values, ""])} disabled={disabled}>
          <Plus size={14} />
          添加{label}
        </button>
      </div>
      {values.map((value, index) => (
        <div className="field repeatable-field" key={`${label}-${index}`}>
          <label htmlFor={`${label}-${index}`}>{label} {index + 1}</label>
          <textarea
            id={`${label}-${index}`}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(values.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
          />
          {values.length > 1 ? (
            <button className="button secondary small" type="button" onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} disabled={disabled}>
              删除{label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MarkdownPreview({ value }: { value: string }) {
  const trimmed = value.trim();
  if (!trimmed) {
    return <div className="markdown-preview markdown-empty">填写评分标准后显示预览。</div>;
  }

  return (
    <div className="markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{trimmed}</ReactMarkdown>
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return <p className="field-error">{message}</p>;
}

function LoadingLabel({ loading, loadingText, text }: { loading: boolean; loadingText: string; text: string }) {
  if (!loading) {
    return text;
  }

  return (
    <>
      <span className="button-spinner" aria-hidden="true" />
      <span>{loadingText}</span>
    </>
  );
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
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
