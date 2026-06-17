"use client";

import { FieldError, LoadingLabel, MarkdownPreview, RepeatableFields } from "./form-controls";
import type { DocumentParseMode, QuestionFormState, SavingAction, TaskFormErrors, TaskFormState } from "./types";

export function TaskSettingsModal({
  closeLabel = "取消",
  errors,
  form,
  saving,
  savingAction,
  submitLabel,
  submitLoadingText,
  title,
  onClose,
  onFieldChange,
  onSubmit
}: {
  closeLabel?: string;
  errors: TaskFormErrors;
  form: TaskFormState;
  saving?: boolean;
  savingAction?: SavingAction | null;
  submitLabel: string;
  submitLoadingText?: string;
  title: string;
  onClose: () => void;
  onFieldChange: (field: keyof TaskFormState, value: string) => void;
  onSubmit: () => void;
}) {
  const prefix = title === "新增任务" ? "task" : "edit-task";
  return (
    <div className="modal-backdrop">
      <section className="modal">
        <div className="panel-title">
          <h3>{title}</h3>
          <button className="icon-button" type="button" onClick={onClose}>×</button>
        </div>
        <TaskSettingsFields form={form} errors={errors} prefix={prefix} onFieldChange={onFieldChange} />
        <div className="actions">
          <button className="button" type="button" onClick={onSubmit} disabled={saving}>
            {submitLoadingText ? (
              <LoadingLabel loading={savingAction === "create_task"} loadingText={submitLoadingText} text={submitLabel} />
            ) : submitLabel}
          </button>
          <button className="button secondary" type="button" onClick={onClose}>{closeLabel}</button>
        </div>
      </section>
    </div>
  );
}

export function SettingsApplyModal({
  saving,
  savingAction,
  onApply,
  onClose
}: {
  saving: boolean;
  savingAction: SavingAction | null;
  onApply: (mode: "regenerate_all" | "future_only") => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal confirm-modal settings-confirm-modal">
        <div className="panel-title">
          <h3>应用新设置</h3>
          <button className="icon-button" type="button" onClick={onClose}>×</button>
        </div>
        <p className="confirm-copy">请选择新设置的应用范围。重新生成会清空所有题目的生成结果和审核记录。</p>
        <div className="settings-confirm-actions">
          <button className="button danger-button" type="button" onClick={() => onApply("regenerate_all")} disabled={saving}>
            <LoadingLabel loading={savingAction === "regenerate_all"} loadingText="处理中" text="全部题目重新生成" />
          </button>
          <button className="button secondary" type="button" onClick={() => onApply("future_only")} disabled={saving}>
            <LoadingLabel loading={savingAction === "future_only"} loadingText="处理中" text="仅未生成题目使用新设置" />
          </button>
          <button className="button secondary" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}

export function DocumentParseModal({
  error,
  fileName,
  parsingMode,
  onClose,
  onParse
}: {
  error: string | null;
  fileName?: string;
  parsingMode: DocumentParseMode | null;
  onClose: () => void;
  onParse: (mode: DocumentParseMode) => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal confirm-modal document-parse-modal">
        <div className="panel-title">
          <h3>选择解析方式</h3>
          <button className="icon-button" type="button" onClick={onClose}>×</button>
        </div>
        <p className="confirm-copy">
          {fileName ?? "Word 文档"} 已选择。普通解析适合格式规整的文档，AI 解析适合题目、材料和问题排版差异较大的文档。
        </p>
        {error ? <p className="modal-error">{error}</p> : null}
        <div className="settings-confirm-actions">
          <button className="button" type="button" onClick={() => onParse("rules")} disabled={Boolean(parsingMode)}>
            <LoadingLabel loading={parsingMode === "rules"} loadingText="解析中" text="普通解析" />
          </button>
          <button className="button secondary" type="button" onClick={() => onParse("ai")} disabled={Boolean(parsingMode)}>
            <LoadingLabel loading={parsingMode === "ai"} loadingText="解析中" text="AI 解析" />
          </button>
          <button className="button secondary" type="button" onClick={onClose} disabled={Boolean(parsingMode)}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}

export function QuestionModal({
  form,
  isEditingLocked,
  onClose,
  onFormChange,
  onSubmit
}: {
  form: QuestionFormState;
  isEditingLocked: boolean;
  onClose: () => void;
  onFormChange: (form: QuestionFormState) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal">
        <div className="panel-title">
          <h3>新增题目</h3>
          <button className="icon-button" type="button" onClick={onClose}>×</button>
        </div>
        <div className="field">
          <label htmlFor="new-question-title">题目名称</label>
          <input id="new-question-title" value={form.title} disabled={isEditingLocked} onChange={(event) => onFormChange({ ...form, title: event.target.value })} />
        </div>
        <RepeatableFields
          label="材料"
          values={form.materials}
          onChange={(materials) => onFormChange({ ...form, materials })}
          disabled={isEditingLocked}
        />
        <RepeatableFields
          label="问题"
          values={form.questions}
          onChange={(questions) => onFormChange({ ...form, questions })}
          disabled={isEditingLocked}
        />
        <div className="actions">
          <button className="button" type="button" onClick={onSubmit} disabled={isEditingLocked}>添加题目</button>
          <button className="button secondary" type="button" onClick={onClose}>取消</button>
        </div>
      </section>
    </div>
  );
}

export function DeleteJobConfirmModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="modal confirm-modal">
        <div className="panel-title">
          <h3>删除任务</h3>
          <button className="icon-button" type="button" onClick={onClose}>×</button>
        </div>
        <p className="confirm-copy">删除后会同时移除该任务下的题目、生成尝试和审核结果。</p>
        <div className="actions">
          <button className="button secondary danger-action" type="button" onClick={onConfirm}>确认删除</button>
          <button className="button" type="button" onClick={onClose}>取消</button>
        </div>
      </section>
    </div>
  );
}

function TaskSettingsFields({
  errors,
  form,
  prefix,
  onFieldChange
}: {
  errors: TaskFormErrors;
  form: TaskFormState;
  prefix: string;
  onFieldChange: (field: keyof TaskFormState, value: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor={`${prefix}-title`}>任务名称</label>
        <input id={`${prefix}-title`} value={form.title} aria-invalid={Boolean(errors.title)} onChange={(event) => onFieldChange("title", event.target.value)} />
        <FieldError message={errors.title} />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-rubric`}>评分标准</label>
        <textarea id={`${prefix}-rubric`} value={form.rubric} aria-invalid={Boolean(errors.rubric)} onChange={(event) => onFieldChange("rubric", event.target.value)} />
        <FieldError message={errors.rubric} />
      </div>
      <div className="rubric-preview">
        <div className="rubric-preview-head">评分标准预览</div>
        <MarkdownPreview value={form.rubric} />
      </div>
      <div className="split">
        <div className="field">
          <label htmlFor={`${prefix}-minutes`}>答题时间</label>
          <input id={`${prefix}-minutes`} type="number" min="1" step="0.5" value={form.answerMinutes} aria-invalid={Boolean(errors.answerMinutes)} onChange={(event) => onFieldChange("answerMinutes", event.target.value)} />
          <FieldError message={errors.answerMinutes} />
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-score`}>通过分数</label>
          <input id={`${prefix}-score`} type="number" min="0" max="100" value={form.passingScore} aria-invalid={Boolean(errors.passingScore)} onChange={(event) => onFieldChange("passingScore", event.target.value)} />
          <FieldError message={errors.passingScore} />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-attempts`}>重试次数</label>
        <input id={`${prefix}-attempts`} type="number" min="1" max="10" value={form.maxAttempts} aria-invalid={Boolean(errors.maxAttempts)} onChange={(event) => onFieldChange("maxAttempts", event.target.value)} />
        <FieldError message={errors.maxAttempts} />
      </div>
    </>
  );
}
