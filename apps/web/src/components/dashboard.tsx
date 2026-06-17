"use client";

import { BadgeCheck, Download, FileUp, Play, Plus, RotateCw, Save, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { estimateAnswerWordRange, shouldPollJobStatus, type GenerationJobStatus } from "@answer-generator/shared";
import { RUBRIC_COMPILING_STATUS } from "@/lib/job-status";
import {
  analyzeRubricRequest,
  appendItemsRequest,
  createJobRequest,
  deleteItemRequest,
  deleteJobRequest,
  loadJobDetailRequest,
  loadJobsRequest,
  parseDocumentRequest,
  runJobRequest,
  saveItemRequest,
  stopJobRequest,
  updateJobSettingsRequest
} from "./dashboard/api";
import { FieldError, LoadingLabel, MarkdownPreview, RepeatableFields } from "./dashboard/form-controls";
import {
  emptyQuestionForm,
  emptyTaskForm,
  type DocumentParseMode,
  type ItemFormState,
  type JobSummary,
  type ParsedQuestionInput,
  type QuestionItem,
  type RunResponse,
  type SavingAction,
  type TaskFormErrors,
  type TaskFormState
} from "./dashboard/types";
import {
  formatBlock,
  formatBlocks,
  formatElapsed,
  latestReviewReasons,
  normalizeApiError,
  parseAnswerSections,
  parseBlocks,
  statusClassName,
  statusLabel,
  validateTaskForm
} from "./dashboard/utils";

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
  const compilingRubricRequests = useRef<Set<string>>(new Set());

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
      processing,
      total
    };
  }, [items]);
  const isPollingActiveJob = shouldPollJobStatus(activeJobStatus);
  const hasActiveItemProcessing = jobProgress.processing > 0;
  const shouldPollActiveJob = isPollingActiveJob || hasActiveItemProcessing;
  const isRubricCompiling = activeJobStatus === RUBRIC_COMPILING_STATUS;
  const isEditingLocked = shouldPollActiveJob;
  const lockedEditMessage = isRubricCompiling ? "正在分析评分标准，完成后可继续操作" : "生成中暂不允许新增或修改题目";
  const canRestartJob = items.length > 0 && !isEditingLocked && activeJobStatus !== "completed";
  const restartJobLabel = activeJobStatus === "draft" ? "开始任务" : activeJobStatus === "cancelled" ? "重新开始任务" : "重新审核未通过";
  const answerSections = useMemo(() => parseAnswerSections(visibleResult?.final_answer ?? ""), [visibleResult?.final_answer]);
  const activeJobSummary = savedJobs.find((job) => job.id === activeJobId) ?? null;
  const elapsedLabel = formatElapsed(activeJobSummary?.startedAt, activeJobSummary?.completedAt, shouldPollActiveJob);

  useEffect(() => {
    void loadJobs();
  }, []);

  useEffect(() => {
    if (!activeJobId || !shouldPollActiveJob) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadJobs({ silent: true });
      void loadJobDetail(activeJobId, { preserveSelection: true, silent: true });
    }, 2500);

    return () => window.clearInterval(timer);
  }, [activeJobId, shouldPollActiveJob]);

  useEffect(() => {
    if (!activeJobId || activeJobStatus !== RUBRIC_COMPILING_STATUS) {
      return;
    }

    void analyzeRubric(activeJobId);
  }, [activeJobId, activeJobStatus]);

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
      setError(isRubricCompiling ? "正在分析评分标准，完成后可修改任务设置" : "生成中暂不允许修改任务设置");
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
      const payload = await createJobRequest(input);
      setActiveJobId(payload.jobId);
      setActiveJobStatus(RUBRIC_COMPILING_STATUS);
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
      void analyzeRubric(payload.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
      setSavingAction(null);
    }
  }

  async function analyzeRubric(jobId: string) {
    if (compilingRubricRequests.current.has(jobId)) {
      return;
    }

    compilingRubricRequests.current.add(jobId);
    try {
      await analyzeRubricRequest(jobId);
      await loadJobs({ silent: true });
      if (jobId === activeJobId || !activeJobId) {
        await loadJobDetail(jobId, { preserveSelection: true, silent: true });
      }
    } catch (err) {
      setError(err instanceof Error ? normalizeApiError(err.message) : "评分标准分析失败");
    } finally {
      compilingRubricRequests.current.delete(jobId);
    }
  }

  function requestUpdateJobSettings() {
    if (isEditingLocked) {
      setError(isRubricCompiling ? "正在分析评分标准，完成后可修改任务设置" : "生成中暂不允许修改任务设置");
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
      setError(isRubricCompiling ? "正在分析评分标准，完成后可修改任务设置" : "生成中暂不允许修改任务设置");
      return;
    }
    setError(null);
    const { input, errors } = validateTaskForm(taskForm);
    setTaskFormErrors(errors);
    if (!input) return;
    setSaving(true);
    setSavingAction(applyMode);
    try {
      await updateJobSettingsRequest(activeJobId, input, applyMode);
      setTitle(input.title);
      setRubric(input.rubric);
      setAnswerMinutes(input.answerMinutes);
      setPassingScore(input.passingScore);
      setMaxAttempts(input.maxAttempts);
      setResult(null);
      setSettingsApplyModalOpen(false);
      await loadJobs();
      await loadJobDetail(activeJobId, { preserveSelection: applyMode === "future_only" });
      void analyzeRubric(activeJobId);
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
      setError(lockedEditMessage);
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
      setDocumentParseError(lockedEditMessage);
      return;
    }
    setParsingDocumentMode(mode);
    setDocumentParseError(null);
    try {
      const parsed = await parseDocumentRequest(pendingDocumentFile, mode);
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

  async function appendItems(nextItems: ParsedQuestionInput[], options?: { focusNewItem?: boolean }) {
    if (!activeJobId) {
      setError("请先新增任务");
      return;
    }
    if (isEditingLocked) {
      setError(lockedEditMessage);
      return;
    }

    let payload;
    try {
      payload = await appendItemsRequest(activeJobId, nextItems);
    } catch (err) {
      setError(err instanceof Error ? normalizeApiError(err.message) : "添加题目失败");
      return;
    }
    await loadJobDetail(activeJobId, { focusItemId: options?.focusNewItem ? payload.items[0]?.id : undefined, preserveSelection: true });
    await loadJobs();
  }

  async function addQuestionFromModal() {
    if (isEditingLocked) {
      setError(lockedEditMessage);
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
      setSavedJobs(await loadJobsRequest());
    } catch {
      return;
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
    let payload;
    try {
      payload = await loadJobDetailRequest(jobId);
    } catch (err) {
      if (!options?.silent) {
        setError(err instanceof Error ? err.message : "加载任务失败");
      }
      return;
    }

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
    if (isRubricCompiling) {
      setError("正在分析评分标准，完成后可开始任务");
      return;
    }

    setError(null);
    let payload;
    try {
      payload = await runJobRequest(activeJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动任务失败");
      return;
    }
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
    try {
      await stopJobRequest(activeJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "停止任务失败");
      return;
    }
    setActiveJobStatus("cancelled");
    await loadJobs();
    await loadJobDetail(activeJobId, { preserveSelection: true });
  }

  async function deleteJob() {
    if (!activeJobId) return;
    setError(null);
    try {
      await deleteJobRequest(activeJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除任务失败");
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
      setError(lockedEditMessage);
      return;
    }
    if (!selected.question.trim()) {
      setError("请至少保留一个问题");
      return;
    }
    setSavingItem(true);
    setError(null);
    try {
      await saveItemRequest(activeJobId, selected);
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
      setError(lockedEditMessage);
      return;
    }
    setError(null);
    try {
      await deleteItemRequest(activeJobId, selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除题目失败");
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
                const jobRunning = shouldPollJobStatus(job.status as GenerationJobStatus) || (job.id === activeJobId && hasActiveItemProcessing);
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
            {items.length > 0 || isRubricCompiling ? (
              <div className="job-progress">
                <div className="job-progress-head">
                  <span>
                    {isRubricCompiling
                      ? "正在分析评分标准中"
                      : jobProgress.activeItem
                      ? `${jobProgress.activeItem.status === "reviewing" ? "当前正在审核" : "当前正在生成"}：${jobProgress.activeItem.title || `题目 ${jobProgress.activeIndex + 1}`}`
                      : isPollingActiveJob
                        ? "等待 Worker 接收任务"
                        : statusLabel(activeJobStatus)}
                  </span>
                  <strong>{isRubricCompiling ? "准备中" : `${jobProgress.percent}%`}</strong>
                </div>
                <div className="job-progress-bar" aria-label={isRubricCompiling ? "评分标准分析中" : `任务进度 ${jobProgress.percent}%`}>
                  <i style={{ width: isRubricCompiling ? "45%" : `${jobProgress.percent}%` }} />
                </div>
                <div className="job-progress-meta">
                  {isRubricCompiling ? (
                    <span>分析完成后可上传 Word、新增题目或修改设置</span>
                  ) : (
                    <>
                      <span>已处理 {jobProgress.completed}/{jobProgress.total}</span>
                      <span>已通过 {jobProgress.passed}</span>
                      <span>待人工 {jobProgress.needsReview}</span>
                      <span>耗时 {elapsedLabel}</span>
                    </>
                  )}
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
                {shouldPollActiveJob ? (
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
                <span>{shouldPollActiveJob ? "自动刷新中" : `${items.length} 题`}</span>
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
            <span>{isRubricCompiling ? "正在分析评分标准中" : "题目队列为空"}</span>
            <p>{isRubricCompiling ? "系统正在整合评分标准和生成提示词，完成后即可上传 Word 或新增题目。" : "等待导入题目材料，生成流程会在题目加入后开始准备。"}</p>
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
