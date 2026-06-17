import type { GenerationJobStatus } from "./types";

const POLLING_STATUSES = new Set<GenerationJobStatus>(["compiling_rubric", "queued", "running"]);

export function shouldPollJobStatus(status: GenerationJobStatus): boolean {
  return POLLING_STATUSES.has(status);
}
