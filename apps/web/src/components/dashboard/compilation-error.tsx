import type { ComponentProps } from "react";
import type { CompilationErrorView } from "./types";

export type CompilationErrorProps = Omit<
  ComponentProps<"section">,
  "children"
> & {
  error: CompilationErrorView;
};

export function CompilationError({
  error,
  className,
  role = "alert",
  ...props
}: CompilationErrorProps) {
  const classes = ["compilation-error", className].filter(Boolean).join(" ");

  return (
    <section {...props} className={classes} role={role}>
      <strong>{error.title}</strong>
      <p>{error.message}</p>
      <span>{error.meta}</span>
      {error.technicalDetails ? (
        <details>
          <summary>查看技术详情</summary>
          <pre>{error.technicalDetails}</pre>
        </details>
      ) : null}
    </section>
  );
}
