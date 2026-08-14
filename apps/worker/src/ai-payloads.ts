import type { RubricSchemaV2 } from "@answer-generator/shared";

export interface RetryFeedback {
  failedCriteria: Array<{
    criterionId: string;
    reason: string;
    repairInstruction: string;
  }>;
  preservedCriteriaIds: string[];
  reasons: string[];
}

export interface ApiReviewFeedback {
  failed_criteria: Array<{
    criterion_id: string;
    reason: string;
    repair_instruction: string;
  }>;
  preserved_criteria_ids: string[];
  reasons: string[];
}

export function buildGeneratePayload(input: {
  material: string | null;
  question: string;
  rubricSchema: RubricSchemaV2;
  answerMinutes: number;
  targetMinWords: number;
  targetWords: number;
  targetMaxWords: number;
  previousFeedback: RetryFeedback | null;
}) {
  return {
    material: input.material,
    question: input.question,
    rubric_schema: toApiRubricSchema(input.rubricSchema),
    answer_minutes: input.answerMinutes,
    target_min_words: input.targetMinWords,
    target_words: input.targetWords,
    target_max_words: input.targetMaxWords,
    previous_feedback: input.previousFeedback
      ? {
          failed_criteria: input.previousFeedback.failedCriteria.map((item) => ({
            criterion_id: item.criterionId,
            reason: item.reason,
            repair_instruction: item.repairInstruction
          })),
          preserved_criteria_ids: input.previousFeedback.preservedCriteriaIds,
          reasons: input.previousFeedback.reasons
        }
      : null
  };
}

export function buildReviewPayload(input: {
  material: string | null;
  question: string;
  rubricSchema: RubricSchemaV2;
  answer: string;
  passingScore: number;
}) {
  return {
    material: input.material,
    question: input.question,
    rubric_schema: toApiRubricSchema(input.rubricSchema),
    answer: input.answer,
    passing_score: input.passingScore
  };
}

export function toRetryFeedback(review: ApiReviewFeedback): RetryFeedback {
  return {
    failedCriteria: review.failed_criteria.map((item) => ({
      criterionId: item.criterion_id,
      reason: item.reason,
      repairInstruction: item.repair_instruction
    })),
    preservedCriteriaIds: review.preserved_criteria_ids,
    reasons: review.reasons
  };
}

function toApiRubricSchema(schema: RubricSchemaV2) {
  return {
    version: schema.version,
    role_prompt: schema.rolePrompt,
    source_requirements: schema.sourceRequirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: requirement.kind
    })),
    global_constraints: schema.globalConstraints.map((constraint) => ({
      id: constraint.id,
      text: constraint.text,
      source_requirement_ids: constraint.sourceRequirementIds
    })),
    dimensions: schema.dimensions.map((dimension) => ({
      id: dimension.id,
      name: dimension.name,
      max_score: dimension.maxScore,
      source_requirement_ids: dimension.sourceRequirementIds,
      criteria: dimension.criteria.map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        source_requirement_ids: criterion.sourceRequirementIds
      })),
      pitfalls: dimension.pitfalls.map((pitfall) => ({
        id: pitfall.id,
        text: pitfall.text,
        source_requirement_ids: pitfall.sourceRequirementIds
      }))
    })),
    answer_principles: schema.answerPrinciples,
    retry_policy: schema.retryPolicy,
    output_rules: schema.outputRules,
    compilation: {
      compiler_model: schema.compilation.compilerModel,
      auditor_model: schema.compilation.auditorModel,
      coverage_passed: schema.compilation.coveragePassed,
      inferred_scores: schema.compilation.inferredScores
    }
  };
}
