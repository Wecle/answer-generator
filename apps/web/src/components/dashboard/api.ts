import type { DocumentParseMode, JobDetailPayload, JobSummary, ParsedQuestionInput, TaskSettingsInput } from "./types";

export async function createJobRequest(input: TaskSettingsInput) {
  return requestJson<{ jobId: string; status: string }>("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, items: [] })
  });
}

export async function analyzeRubricRequest(jobId: string) {
  return requestJson<{ jobId: string; status: string }>(`/api/jobs/${jobId}/compile-rubric`, { method: "POST" });
}

export async function updateJobSettingsRequest(jobId: string, input: TaskSettingsInput, applyMode: "regenerate_all" | "future_only") {
  return requestJson(`/api/jobs/${jobId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, applyMode })
  });
}

export async function parseDocumentRequest(file: File, mode: DocumentParseMode) {
  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  const payload = await requestJson<{ questions: Array<{ title?: string | null; material?: string | null; question: string }> }>("/api/documents/parse", {
    method: "POST",
    body: form
  });

  return payload.questions.map((question, index) => ({
    title: question.title?.trim() || `Word 题目 ${index + 1}`,
    material: question.material ?? "",
    question: question.question
  }));
}

export async function appendItemsRequest(jobId: string, items: ParsedQuestionInput[]) {
  return requestJson<{ items: Array<{ id: string }> }>(`/api/jobs/${jobId}/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items })
  });
}

export async function loadJobsRequest() {
  const payload = await requestJson<{ jobs: JobSummary[] }>("/api/jobs");
  return payload.jobs;
}

export async function loadJobDetailRequest(jobId: string) {
  return requestJson<JobDetailPayload>(`/api/jobs/${jobId}`);
}

export async function runJobRequest(jobId: string) {
  return requestJson<{ workerOnline?: boolean }>(`/api/jobs/${jobId}/run`, { method: "POST" });
}

export async function stopJobRequest(jobId: string) {
  return requestJson(`/api/jobs/${jobId}/stop`, { method: "POST" });
}

export async function deleteJobRequest(jobId: string) {
  return requestJson(`/api/jobs/${jobId}`, { method: "DELETE" });
}

export async function saveItemRequest(jobId: string, item: { id: string; title: string; material: string; question: string }) {
  return requestJson(`/api/jobs/${jobId}/items/${item.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: item.title || "未命名题目",
      material: item.material,
      question: item.question
    })
  });
}

export async function deleteItemRequest(jobId: string, itemId: string) {
  return requestJson(`/api/jobs/${jobId}/items/${itemId}`, { method: "DELETE" });
}

async function requestJson<T = unknown>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}
