"use client";

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
import { DeleteJobConfirmModal, DocumentParseModal, QuestionModal, SettingsApplyModal, TaskSettingsModal } from "./dashboard/modals";
import {
  CurrentQuestionPanel,
  DashboardHome,
  DashboardSidebar,
  EmptyQueueState,
  JobToolbar,
  QuestionQueue,
  ResultPanel
} from "./dashboard/sections";
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
      setActiveJobStatus(payload.status as GenerationJobStatus);
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
      <DashboardSidebar
        activeJobId={activeJobId}
        hasActiveItemProcessing={hasActiveItemProcessing}
        loadingJobs={loadingJobs}
        savedJobs={savedJobs}
        onCreateTask={openCreateTaskModal}
        onRefreshJobs={() => void loadJobs()}
        onSelectJob={(jobId) => void loadJobDetail(jobId)}
      />
      <section className="workspace">
        {activeJobId ? (
          <JobToolbar
            activeJobId={activeJobId}
            activeJobStatus={activeJobStatus}
            canRestartJob={canRestartJob}
            elapsedLabel={elapsedLabel}
            isEditingLocked={isEditingLocked}
            isPollingActiveJob={isPollingActiveJob}
            isRubricCompiling={isRubricCompiling}
            itemCount={items.length}
            jobProgress={jobProgress}
            restartJobLabel={restartJobLabel}
            shouldPollActiveJob={shouldPollActiveJob}
            title={title}
            onDeleteJob={() => setDeleteJobConfirmOpen(true)}
            onEditTask={openEditTaskModal}
            onOpenQuestionModal={() => setQuestionModalOpen(true)}
            onRunJob={runSavedJob}
            onStopJob={stopJob}
            onUploadWord={handleDocumentFile}
          />
        ) : null}

        {error ? <div className="error">{error}</div> : null}

        {!activeJobId ? (
          <DashboardHome stats={dashboardStats} />
        ) : (
          items.length > 0 ? (
            <div className={selected ? "task-layout" : "task-layout queue-only"}>
              <QuestionQueue
                isEditingLocked={isEditingLocked}
                items={items}
                selectedId={selected?.id ?? ""}
                shouldPollActiveJob={shouldPollActiveJob}
                onAddQuestion={() => setQuestionModalOpen(true)}
                onSelectItem={(itemId) => {
                  setSelectedId(itemId);
                  setResult(null);
                }}
              />
              {selected ? (
                <CurrentQuestionPanel
                  form={selectedForm}
                  isEditingLocked={isEditingLocked}
                  savingItem={savingItem}
                  selected={selected}
                  wordRange={wordRange}
                  onDelete={deleteSelectedItem}
                  onMaterialChange={updateSelectedMaterials}
                  onQuestionChange={updateSelectedQuestions}
                  onSave={saveSelectedItem}
                  onTitleChange={(nextTitle) => updateSelected({ title: nextTitle })}
                />
              ) : null}
              {selected ? (
                <ResultPanel
                  answerSections={answerSections}
                  result={result}
                  retryFeedbackAttempts={retryFeedbackAttempts}
                  selected={selected}
                  selectedLatestReview={selectedLatestReview}
                  visibleResult={visibleResult}
                />
              ) : null}
            </div>
          ) : (
            <EmptyQueueState isRubricCompiling={isRubricCompiling} />
          )
        )}
      </section>
      {taskModalOpen ? (
        <TaskSettingsModal
          errors={taskFormErrors}
          form={taskForm}
          saving={saving}
          savingAction={savingAction}
          submitLabel="创建任务"
          submitLoadingText="创建中"
          title="新增任务"
          onClose={() => setTaskModalOpen(false)}
          onFieldChange={updateTaskFormField}
          onSubmit={createJob}
        />
      ) : null}
      {editTaskModalOpen ? (
        <TaskSettingsModal
          errors={taskFormErrors}
          form={taskForm}
          submitLabel="确认修改"
          title="修改任务设置"
          onClose={() => setEditTaskModalOpen(false)}
          onFieldChange={updateTaskFormField}
          onSubmit={requestUpdateJobSettings}
        />
      ) : null}
      {settingsApplyModalOpen ? (
        <SettingsApplyModal
          saving={saving}
          savingAction={savingAction}
          onApply={updateJobSettings}
          onClose={() => setSettingsApplyModalOpen(false)}
        />
      ) : null}
      {documentParseModalOpen ? (
        <DocumentParseModal
          error={documentParseError}
          fileName={pendingDocumentFile?.name}
          parsingMode={parsingDocumentMode}
          onClose={() => {
            if (parsingDocumentMode) return;
            setDocumentParseModalOpen(false);
            setPendingDocumentFile(null);
          }}
          onParse={parseDocument}
        />
      ) : null}
      {questionModalOpen ? (
        <QuestionModal
          form={questionForm}
          isEditingLocked={isEditingLocked}
          onClose={() => setQuestionModalOpen(false)}
          onFormChange={setQuestionForm}
          onSubmit={addQuestionFromModal}
        />
      ) : null}
      {deleteJobConfirmOpen ? (
        <DeleteJobConfirmModal onClose={() => setDeleteJobConfirmOpen(false)} onConfirm={deleteJob} />
      ) : null}
    </main>
  );
}
