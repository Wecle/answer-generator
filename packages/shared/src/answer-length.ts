export interface AnswerWordRange {
  minWords: number;
  targetWords: number;
  maxWords: number;
}

const MIN_TARGET_WORDS = 260;
const MAX_TARGET_WORDS = 1800;
const WORDS_PER_MINUTE = 260;

export function estimateAnswerWordRange(minutes: number): AnswerWordRange {
  const normalizedMinutes = Number.isFinite(minutes) ? Math.max(minutes, 1) : 1;
  const rawTarget = Math.round(normalizedMinutes * WORDS_PER_MINUTE);
  const targetWords = clamp(rawTarget, MIN_TARGET_WORDS, MAX_TARGET_WORDS);

  return {
    minWords: Math.round(targetWords * 0.8 / 10) * 10,
    targetWords,
    maxWords: Math.round(targetWords * 1.2 / 10) * 10
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

