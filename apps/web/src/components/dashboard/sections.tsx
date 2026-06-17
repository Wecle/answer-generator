"use client";

import { BadgeCheck, Download, FileUp, Play, Plus, RotateCw, Save, Settings } from "lucide-react";
import { shouldPollJobStatus, type GenerationJobStatus } from "@answer-generator/shared";
import { RepeatableFields } from "./form-controls";
import type { AnswerSection, DashboardStats, ItemFormState, JobProgressView, JobSummary, QuestionItem, RunResponse } from "./types";
import { formatElapsed, statusClassName, statusLabel } from "./utils";

export function DashboardSidebar({
  activeJobId,
  hasActiveItemProcessing,
  loadingJobs,
  savedJobs,
  onCreateTask,
  onRefreshJobs,
  onSelectJob
}: {
  activeJobId: string | null;
  hasActiveItemProcessing: boolean;
  loadingJobs: boolean;
  savedJobs: JobSummary[];
  onCreateTask: () => void;
  onRefreshJobs: () => void;
  onSelectJob: (jobId: string) => void;
}) {
  return (
    <aside className="rail">
      <div className="brand">
        <span className="brand-mark">AG</span>
        <span>Answer Generator</span>
      </div>
      <button className="button new-task-button" type="button" onClick={onCreateTask}>
        <Plus size={16} />
        新增任务
      </button>
      <div className="saved-jobs">
        <div className="saved-jobs-head">
          <span>任务列表</span>
          <button type="button" onClick={onRefreshJobs} disabled={loadingJobs}>
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
                  onClick={() => onSelectJob(job.id)}
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
  );
}

export function DashboardHome({ stats }: { stats: DashboardStats }) {
  return (
    <section className="dashboard-home">
      <div className="panel-title">
        <h3>仪表盘</h3>
        <span>任务概览</span>
      </div>
      <div className="dashboard-cards">
        <DashboardStatCard label="任务总数" value={stats.totalTasks} />
        <DashboardStatCard label="题目总数" value={stats.totalItems} />
        <DashboardStatCard label="审核总数" value={stats.reviewedItems} />
        <DashboardStatCard label="审核成功" value={stats.passedItems} />
        <DashboardStatCard label="已完成任务" value={stats.completedTasks} />
        <DashboardStatCard label="失败题目" value={stats.failedItems} />
        <DashboardStatCard label="待人工处理" value={stats.needsReviewItems} />
        <DashboardStatCard label="审核成功率" value={`${stats.successRate}%`} wide />
      </div>
    </section>
  );
}

export function JobToolbar({
  activeJobId,
  activeJobStatus,
  canRestartJob,
  elapsedLabel,
  isEditingLocked,
  isPollingActiveJob,
  isRubricCompiling,
  itemCount,
  jobProgress,
  restartJobLabel,
  shouldPollActiveJob,
  title,
  onDeleteJob,
  onEditTask,
  onRunJob,
  onStopJob,
  onUploadWord,
  onOpenQuestionModal
}: {
  activeJobId: string;
  activeJobStatus: GenerationJobStatus;
  canRestartJob: boolean;
  elapsedLabel: string;
  isEditingLocked: boolean;
  isPollingActiveJob: boolean;
  isRubricCompiling: boolean;
  itemCount: number;
  jobProgress: JobProgressView;
  restartJobLabel: string;
  shouldPollActiveJob: boolean;
  title: string;
  onDeleteJob: () => void;
  onEditTask: () => void;
  onRunJob: () => void;
  onStopJob: () => void;
  onUploadWord: (file: File | null) => void;
  onOpenQuestionModal: () => void;
}) {
  return (
    <div className="toolbar">
      <div className="toolbar-copy">
        <h2>{title}</h2>
        {itemCount > 0 || isRubricCompiling ? (
          <JobProgress
            activeJobStatus={activeJobStatus}
            elapsedLabel={elapsedLabel}
            isPollingActiveJob={isPollingActiveJob}
            isRubricCompiling={isRubricCompiling}
            jobProgress={jobProgress}
          />
        ) : null}
      </div>
      <div className="top-actions">
        {!isEditingLocked ? (
          <button className="button secondary" type="button" onClick={onEditTask}>
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
              onUploadWord(event.target.files?.[0] ?? null);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <button className="button secondary" type="button" onClick={onOpenQuestionModal} disabled={isEditingLocked}>
          <Plus size={16} />
          新增题目
        </button>
        {itemCount > 0 ? (
          <>
            {canRestartJob ? (
              <button className="button" type="button" onClick={onRunJob}>
                <Play size={16} />
                {restartJobLabel}
              </button>
            ) : null}
            {shouldPollActiveJob ? (
              <button className="button secondary" type="button" onClick={onStopJob}>
                <RotateCw size={16} />
                停止
              </button>
            ) : null}
            <button className="button secondary danger-action" type="button" onClick={onDeleteJob}>
              删除
            </button>
            <a className="button secondary" href={`/api/jobs/${activeJobId}/export`}>
              <Download size={16} />
              导出结果
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function QuestionQueue({
  isEditingLocked,
  items,
  selectedId,
  shouldPollActiveJob,
  onAddQuestion,
  onSelectItem
}: {
  isEditingLocked: boolean;
  items: QuestionItem[];
  selectedId: string;
  shouldPollActiveJob: boolean;
  onAddQuestion: () => void;
  onSelectItem: (itemId: string) => void;
}) {
  return (
    <section className="panel queue-panel">
      <div className="panel-title">
        <h3>题目队列</h3>
        <div className="queue-title-actions">
          <span>{shouldPollActiveJob ? "自动刷新中" : `${items.length} 题`}</span>
          <button className="button secondary small" type="button" onClick={onAddQuestion} disabled={isEditingLocked}>
            <Plus size={14} />
            新增题目
          </button>
        </div>
      </div>
      <div className="items">
        {items.map((item, index) => (
          <button
            className={item.id === selectedId ? "item active" : "item"}
            key={item.id}
            type="button"
            onClick={() => onSelectItem(item.id)}
          >
            <div className="item-head">
              <strong>{item.title || `题目 ${index + 1}`}</strong>
              <span className={statusClassName(item.status)}>{item.id === selectedId ? (isEditingLocked ? "查看中" : "编辑中") : statusLabel(item.status ?? "pending")}</span>
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
  );
}

export function CurrentQuestionPanel({
  form,
  isEditingLocked,
  savingItem,
  selected,
  wordRange,
  onDelete,
  onMaterialChange,
  onQuestionChange,
  onSave,
  onTitleChange
}: {
  form: ItemFormState | null;
  isEditingLocked: boolean;
  savingItem: boolean;
  selected: QuestionItem;
  wordRange: { minWords: number; maxWords: number };
  onDelete: () => void;
  onMaterialChange: (values: string[]) => void;
  onQuestionChange: (values: string[]) => void;
  onSave: () => void;
  onTitleChange: (title: string) => void;
}) {
  return (
    <section className="panel active-question-panel" key={selected.id}>
      <div className="panel-title">
        <h3>当前题目</h3>
        <span>{isEditingLocked ? "生成中只读" : `${wordRange.minWords}-${wordRange.maxWords} 字`}</span>
      </div>
      <div className="field">
        <label htmlFor="question-title">题目名称</label>
        <input id="question-title" value={selected.title} disabled={isEditingLocked} onChange={(event) => onTitleChange(event.target.value)} />
      </div>
      <RepeatableFields label="材料" values={form?.materials ?? [""]} onChange={onMaterialChange} disabled={isEditingLocked} />
      <RepeatableFields label="问题" values={form?.questions ?? [""]} onChange={onQuestionChange} disabled={isEditingLocked} />
      <div className="actions item-actions">
        <button className="button secondary" type="button" onClick={onSave} disabled={savingItem || isEditingLocked}>
          <Save size={16} />
          {savingItem ? "保存中" : "保存题目"}
        </button>
        <button className="button secondary danger-action" type="button" onClick={onDelete} disabled={isEditingLocked}>
          删除题目
        </button>
      </div>
    </section>
  );
}

export function ResultPanel({
  answerSections,
  result,
  retryFeedbackAttempts,
  selected,
  selectedLatestReview,
  visibleResult
}: {
  answerSections: AnswerSection[];
  result: RunResponse | null;
  retryFeedbackAttempts: RunResponse["attempts"];
  selected: QuestionItem;
  selectedLatestReview: NonNullable<QuestionItem["attempts"]>[number]["review"] | null | undefined;
  visibleResult: RunResponse | null;
}) {
  return (
    <section className="panel active-question-panel result-panel" key={`${selected.id}-result`}>
      <div className="panel-title">
        <h3>生成结果</h3>
        <span>{statusLabel(selected.status ?? (result ? result.status : "pending"))}</span>
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
          <ResultReview visibleResult={visibleResult} />
          {retryFeedbackAttempts.length > 0 ? <RetryNotes attempts={retryFeedbackAttempts} /> : null}
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
    </section>
  );
}

export function EmptyQueueState({ isRubricCompiling }: { isRubricCompiling: boolean }) {
  return (
    <section className="empty-queue-state">
      <span>{isRubricCompiling ? "正在分析评分标准中" : "题目队列为空"}</span>
      <p>{isRubricCompiling ? "系统正在整合评分标准和生成提示词，完成后即可上传 Word 或新增题目。" : "等待导入题目材料，生成流程会在题目加入后开始准备。"}</p>
    </section>
  );
}

function DashboardStatCard({ label, value, wide = false }: { label: string; value: number | string; wide?: boolean }) {
  return (
    <div className={wide ? "dashboard-card wide" : "dashboard-card"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function JobProgress({
  activeJobStatus,
  elapsedLabel,
  isPollingActiveJob,
  isRubricCompiling,
  jobProgress
}: {
  activeJobStatus: GenerationJobStatus;
  elapsedLabel: string;
  isPollingActiveJob: boolean;
  isRubricCompiling: boolean;
  jobProgress: JobProgressView;
}) {
  return (
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
  );
}

function ResultReview({ visibleResult }: { visibleResult: RunResponse }) {
  return (
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
  );
}

function RetryNotes({ attempts }: { attempts: RunResponse["attempts"] }) {
  return (
    <div className="retry-notes">
      <h4>重试意见</h4>
      {attempts.map((attempt) => (
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
  );
}
