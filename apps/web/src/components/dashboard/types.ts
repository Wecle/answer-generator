export interface QuestionItem {
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

export interface ItemFormState {
  materials: string[];
  questions: string[];
}

export interface TaskFormState {
  title: string;
  rubric: string;
  answerMinutes: string;
  passingScore: string;
  maxAttempts: string;
}

export interface TaskSettingsInput {
  title: string;
  rubric: string;
  answerMinutes: number;
  passingScore: number;
  maxAttempts: number;
}

export interface QuestionFormState {
  title: string;
  materials: string[];
  questions: string[];
}

export type TaskFormErrors = Partial<Record<keyof TaskFormState, string>>;
export type SavingAction = "create_task" | "regenerate_all" | "future_only";
export type DocumentParseMode = "rules" | "ai";

export interface JobSummary {
  id: string;
  title: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  progress: {
    totalItems: number;
    passedItems: number;
    needsReviewItems: number;
    failedItems: number;
    progressPercent: number;
  };
}

export interface ParsedQuestionInput {
  title: string;
  material: string;
  question: string;
}

export interface JobDetailPayload {
  job: {
    id: string;
    title: string;
    rubric: string;
    answerMinutes: string;
    passingScore: number;
    maxAttempts: number;
    status: import("@answer-generator/shared").GenerationJobStatus;
    startedAt: string | null;
    completedAt: string | null;
  };
  items: Array<{
    id: string;
    title: string;
    material: string | null;
    question: string;
    status: string;
    finalAnswer: string | null;
    finalScore: number | null;
    attempts: NonNullable<QuestionItem["attempts"]>;
  }>;
}

export interface RunResponse {
  status: "passed" | "needs_review";
  final_answer: string;
  final_score: number;
  reasons: string[];
  attempts: Array<{
    attempt_number: number;
    review: {
      total_score: number;
      passed: boolean;
      reasons?: string[];
    };
  }>;
}

export const emptyTaskForm = {
  title: "",
  rubric: "",
  answerMinutes: "",
  passingScore: "",
  maxAttempts: ""
} satisfies TaskFormState;

export const emptyQuestionForm = {
  title: "",
  materials: [""],
  questions: [""]
} satisfies QuestionFormState;
