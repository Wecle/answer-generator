import type { GenerationJobStatus } from "./types";

const POLLING_STATUSES = new Set<GenerationJobStatus>(["queued", "running"]);

export function shouldPollJobStatus(status: GenerationJobStatus): boolean {
  return POLLING_STATUSES.has(status);
}
