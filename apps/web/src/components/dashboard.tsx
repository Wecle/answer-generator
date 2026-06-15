"use client";

import { BadgeCheck, Download, FileUp, Play, Plus, RotateCw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

interface JobSummary {
  id: string;
  title: string;
  status: string;
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
  title: "新答案生成任务",
  rubric: "审题准确、逻辑清晰、措施可行、群众需求、闭环管理、表达自然",
  answerMinutes: 2,
  passingScore: 95,
  maxAttempts: 3
};

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
  const [questionModalOpen, setQuestionModalOpen] = useState(false);
  const [deleteJobConfirmOpen, setDeleteJobConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [savedJobs, setSavedJobs] = useState<JobSummary[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJobStatus, setActiveJobStatus] = useState<GenerationJobStatus>("draft");
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            passed: attempt.review?.passed ?? false
          }
        })) ?? [],
        reasons: latestReviewReasons(selected)
      } satisfies RunResponse
    : null;
  const visibleResult = selected ? result ?? persistedResult : null;
  const selectedLatestReview = selected?.attempts?.at(-1)?.review ?? null;
  const isPollingActiveJob = shouldPollJobStatus(activeJobStatus);
  const canRestartJob = items.length > 0 && !isPollingActiveJob && activeJobStatus !== "completed";
  const restartJobLabel = activeJobStatus === "draft" ? "开始任务" : activeJobStatus === "cancelled" ? "重新开始任务" : "重新审核未通过";
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

  function updateSelected(patch: Partial<QuestionItem>) {
    if (!selected) return;
    setItems((current) => current.map((item) => (item.id === selected.id ? { ...item, ...patch } : item)));
  }

  function updateSelectedMaterials(materials: string[]) {
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
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...taskForm, items: [] })
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const payload = (await response.json()) as { jobId: string };
      setActiveJobId(payload.jobId);
      setActiveJobStatus("draft");
      setTitle(taskForm.title);
      setRubric(taskForm.rubric);
      setAnswerMinutes(taskForm.answerMinutes);
      setPassingScore(taskForm.passingScore);
      setMaxAttempts(taskForm.maxAttempts);
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
    }
  }

  async function parseDocument(file: File | null) {
    if (!file) return;
    if (!activeJobId) {
      setError("请先新增任务");
      return;
    }
    setError(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await fetch("/api/documents/parse", { method: "POST", body: form });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const payload = (await response.json()) as { questions: Array<{ material?: string | null; question: string }> };
      const parsed = payload.questions.map((question, index) => ({
        title: `Word 题目 ${index + 1}`,
        material: question.material ?? "",
        question: question.question
      }));
      if (parsed.length > 0) {
        await appendItems(parsed);
        setResult(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析失败");
    }
  }

  async function appendItems(nextItems: Array<{ title: string; material: string; question: string }>, options?: { focusNewItem?: boolean }) {
    if (!activeJobId) {
      setError("请先新增任务");
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
      setTaskModalOpen(true);
      return;
    }

    setError(null);
    const response = await fetch(`/api/jobs/${activeJobId}/run`, { method: "POST" });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    const payload = (await response.json()) as { workerOnline?: boolean };
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
        <button className="button new-task-button" type="button" onClick={() => setTaskModalOpen(true)}>
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
              savedJobs.slice(0, 6).map((job) => (
                <button
                  className={job.id === activeJobId ? "saved-job active" : "saved-job"}
                  key={job.id}
                  type="button"
                  onClick={() => loadJobDetail(job.id)}
                >
                  <strong>{job.title}</strong>
                  <span>
                    {statusLabel(job.status)} · {job.progress.progressPercent}%
                  </span>
                  <span className="saved-job-bar" aria-hidden="true">
                    <i style={{ width: `${job.progress.progressPercent}%` }} />
                  </span>
                </button>
              ))
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
                </div>
              </div>
            ) : null}
          </div>
          <div className="top-actions">
            <label className="button secondary">
              <FileUp size={16} />
              上传 Word
              <input hidden type="file" accept=".docx" onChange={(event) => parseDocument(event.target.files?.[0] ?? null)} />
            </label>
            <button className="button secondary" type="button" onClick={() => setQuestionModalOpen(true)}>
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
                <button className="button secondary small" type="button" onClick={() => setQuestionModalOpen(true)}>
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
                    <span className={statusClassName(item.status)}>{item.id === selected?.id ? "编辑中" : statusLabel(item.status ?? "pending")}</span>
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
              <span>{wordRange.minWords}-{wordRange.maxWords} 字</span>
            </div>
            <div className="field">
              <label htmlFor="question-title">题目名称</label>
              <input id="question-title" value={selected.title} onChange={(event) => updateSelected({ title: event.target.value })} />
            </div>
            <RepeatableFields
              label="材料"
              values={selectedForm?.materials ?? [""]}
              onChange={updateSelectedMaterials}
            />
            <RepeatableFields
              label="问题"
              values={selectedForm?.questions ?? [""]}
              onChange={updateSelectedQuestions}
            />
            <div className="actions item-actions">
              <button className="button secondary" type="button" onClick={saveSelectedItem} disabled={savingItem}>
                <Save size={16} />
                {savingItem ? "保存中" : "保存题目"}
              </button>
              <button className="button secondary danger-action" type="button" onClick={deleteSelectedItem}>
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
                <div className="result">{visibleResult.final_answer}</div>
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
                <div className="reasons">
                  {visibleResult.reasons.map((reason) => (
                    <span key={reason}>{reason}</span>
                  ))}
                </div>
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
          <section className="panel empty-workspace">
            <div className="panel-title">
              <h3>添加题目</h3>
              <span>等待题目</span>
            </div>
            <div className="actions">
              <label className="button secondary">
                <FileUp size={16} />
                上传 Word
                <input hidden type="file" accept=".docx" onChange={(event) => parseDocument(event.target.files?.[0] ?? null)} />
              </label>
              <button className="button" type="button" onClick={() => setQuestionModalOpen(true)}>
                <Plus size={16} />
                新增题目
              </button>
            </div>
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
              <input id="task-title" value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="task-rubric">评分标准</label>
              <textarea id="task-rubric" value={taskForm.rubric} onChange={(event) => setTaskForm({ ...taskForm, rubric: event.target.value })} />
            </div>
            <div className="split">
              <div className="field">
                <label htmlFor="task-minutes">答题时间</label>
                <input id="task-minutes" type="number" min="1" step="0.5" value={taskForm.answerMinutes} onChange={(event) => setTaskForm({ ...taskForm, answerMinutes: Number(event.target.value) })} />
              </div>
              <div className="field">
                <label htmlFor="task-score">通过分数</label>
                <input id="task-score" type="number" min="0" max="100" value={taskForm.passingScore} onChange={(event) => setTaskForm({ ...taskForm, passingScore: Number(event.target.value) })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="task-attempts">重试次数</label>
              <input id="task-attempts" type="number" min="1" max="10" value={taskForm.maxAttempts} onChange={(event) => setTaskForm({ ...taskForm, maxAttempts: Number(event.target.value) })} />
            </div>
            <div className="actions">
              <button className="button" type="button" onClick={createJob} disabled={saving}>
                {saving ? "创建中" : "创建任务"}
              </button>
              <button className="button secondary" type="button" onClick={() => setTaskModalOpen(false)}>取消</button>
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
              <input id="new-question-title" value={questionForm.title} onChange={(event) => setQuestionForm({ ...questionForm, title: event.target.value })} />
            </div>
            <RepeatableFields
              label="材料"
              values={questionForm.materials}
              onChange={(materials) => setQuestionForm((current) => ({ ...current, materials }))}
            />
            <RepeatableFields
              label="问题"
              values={questionForm.questions}
              onChange={(questions) => setQuestionForm((current) => ({ ...current, questions }))}
            />
            <div className="actions">
              <button className="button" type="button" onClick={addQuestionFromModal}>添加题目</button>
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function RepeatableFields({
  label,
  values,
  onChange
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="repeatable">
      <div className="repeatable-head">
        <span>{label}</span>
        <button className="button secondary small" type="button" onClick={() => onChange([...values, ""])}>
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
            onChange={(event) => onChange(values.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
          />
          {values.length > 1 ? (
            <button className="button secondary small" type="button" onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}>
              删除{label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
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
