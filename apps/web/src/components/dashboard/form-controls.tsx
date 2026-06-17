"use client";

import { Plus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function RepeatableFields({
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

export function MarkdownPreview({ value }: { value: string }) {
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

export function FieldError({ message }: { message?: string }) {
  if (!message) {
    return null;
  }

  return <p className="field-error">{message}</p>;
}

export function LoadingLabel({ loading, loadingText, text }: { loading: boolean; loadingText: string; text: string }) {
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
