export const RUBRIC_COMPILING_STATUS = "compiling_rubric";

const terminalJobStatuses = new Set(["completed", "needs_review", "failed", "cancelled"]);

export function isRubricCompiling(status: string | null | undefined) {
  return status === RUBRIC_COMPILING_STATUS;
}

export function isTerminalJobStatus(status: string | null | undefined) {
  return status ? terminalJobStatuses.has(status) : false;
}

export function deriveJobTiming<T extends Date | string | null | undefined>(job: {
  status: string;
  startedAt?: T;
  completedAt?: T;
  createdAt?: T;
  updatedAt?: T;
}) {
  return {
    startedAt: job.startedAt ?? (job.status === "draft" || isRubricCompiling(job.status) ? null : job.createdAt ?? null),
    completedAt: job.completedAt ?? (isTerminalJobStatus(job.status) ? job.updatedAt ?? null : null)
  };
}
