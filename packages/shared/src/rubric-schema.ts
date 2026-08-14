export type SourceRequirementKind =
  | "dimension"
  | "criterion"
  | "pitfall"
  | "score"
  | "global";

export interface SourceRequirement {
  id: string;
  text: string;
  kind: SourceRequirementKind;
}

export interface RubricCriterion {
  id: string;
  text: string;
  sourceRequirementIds: string[];
}

export interface RubricPitfall {
  id: string;
  text: string;
  sourceRequirementIds: string[];
}

export interface RubricGlobalConstraint {
  id: string;
  text: string;
  sourceRequirementIds: string[];
}

export interface RubricDimensionV2 {
  id: string;
  name: string;
  maxScore: number;
  sourceRequirementIds: string[];
  criteria: RubricCriterion[];
  pitfalls: RubricPitfall[];
}

export interface RubricBonusRule {
  id: string;
  text: string;
  minScore: number;
  maxScore: number;
  sourceRequirementIds: string[];
}

export type RubricPenaltyEffect =
  | "deduct"
  | "cap"
  | "set_range"
  | "veto"
  | "qualitative";

export interface RubricPenaltyRule {
  id: string;
  text: string;
  effect: RubricPenaltyEffect;
  score?: number | null;
  minScore?: number | null;
  maxScore?: number | null;
  sourceRequirementIds: string[];
}

export interface RubricScoreConflict {
  text: string;
  sourceRequirementIds: string[];
}

export interface RubricNormalization {
  rawMaxScore: number;
  targetMaxScore: 100;
  method: "linear";
}

export interface RubricScoringPolicy {
  mode: "normalized_rules";
  baseMaxScore: number;
  bonusRules: RubricBonusRule[];
  penaltyRules: RubricPenaltyRule[];
  scoreConflicts: RubricScoreConflict[];
  normalization: RubricNormalization;
}

export interface RubricSchemaV2 {
  version: "v2";
  rolePrompt: string;
  sourceRequirements: SourceRequirement[];
  globalConstraints: RubricGlobalConstraint[];
  dimensions: RubricDimensionV2[];
  scoringPolicy?: RubricScoringPolicy | null;
  answerPrinciples: string[];
  retryPolicy: string[];
  outputRules: string[];
  compilation: {
    compilerModel: string;
    auditorModel: string | null;
    coveragePassed: boolean;
    inferredScores: boolean;
  };
}

export interface RubricSchemaV1 {
  rolePrompt: string;
  answerPrinciples: string[];
  dimensions: Array<{
    name: string;
    maxScore: number;
    criteria: string[];
    pitfalls: string[];
  }>;
  retryPolicy: string[];
  outputRules: string[];
}

export type PersistedRubricSchema = RubricSchemaV1 | RubricSchemaV2;

export interface RubricCompilationState {
  stage: string;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
  compilerModel?: string;
  auditorModel?: string;
  updatedAt: string;
}

export interface PromptMetadata {
  pipelineVersion: "generation-pipe-v1";
  schemaVersion: "rubric-schema-v2";
  basePromptVersion: "base-v1";
  rubricPromptVersion: "rubric-v1";
  retryPromptVersion: "retry-v1";
  loadedSections: string[];
}

export interface FailedCriterion {
  criterionId: string;
  reason: string;
  repairInstruction: string;
}

export interface PersistedReviewDimension {
  dimensionId: string;
  name: string;
  score: number;
  maxScore: number;
}

export interface LegacyPersistedReviewDimension {
  name: string;
  score: number;
  maxScore: number;
}

export type PersistedReviewDimensionRecord =
  | PersistedReviewDimension
  | LegacyPersistedReviewDimension;

export function isVerifiedRubricSchemaV2(
  value: unknown
): value is RubricSchemaV2 {
  if (!value || typeof value !== "object") {
    return false;
  }

  const schema = value as Partial<RubricSchemaV2>;
  if (
    schema.version !== "v2" ||
    !isNonEmptyString(schema.rolePrompt) ||
    !isStringArray(schema.answerPrinciples) ||
    !isStringArray(schema.retryPolicy) ||
    !isStringArray(schema.outputRules) ||
    !isCompilationMetadata(schema.compilation) ||
    !Array.isArray(schema.sourceRequirements) ||
    schema.sourceRequirements.length === 0 ||
    !schema.sourceRequirements.every(isSourceRequirement) ||
    !Array.isArray(schema.globalConstraints) ||
    !schema.globalConstraints.every(isMappedTextItem) ||
    !Array.isArray(schema.dimensions) ||
    schema.dimensions.length === 0 ||
    !schema.dimensions.every(isDimension)
  ) {
    return false;
  }

  const requirementIds = new Set(
    schema.sourceRequirements.map((requirement) => requirement.id)
  );
  const scoringPolicy = schema.scoringPolicy;
  if (scoringPolicy != null && !isScoringPolicy(scoringPolicy)) {
    return false;
  }
  const mappedItems = [
    ...schema.globalConstraints,
    ...schema.dimensions,
    ...schema.dimensions.flatMap((dimension) => [
      ...dimension.criteria,
      ...dimension.pitfalls
    ]),
    ...(scoringPolicy?.bonusRules ?? []),
    ...(scoringPolicy?.penaltyRules ?? []),
    ...(scoringPolicy?.scoreConflicts ?? [])
  ];
  const referencedIds = mappedItems.flatMap(
    (item) => item.sourceRequirementIds
  );
  const mappedIds = new Set(referencedIds);
  const allIds = [
    ...schema.sourceRequirements.map((item) => item.id),
    ...schema.globalConstraints.map((item) => item.id),
    ...schema.dimensions.map((item) => item.id),
    ...schema.dimensions.flatMap((dimension) =>
      dimension.criteria.map((item) => item.id)
    ),
    ...schema.dimensions.flatMap((dimension) =>
      dimension.pitfalls.map((item) => item.id)
    ),
    ...(scoringPolicy?.bonusRules.map((item) => item.id) ?? []),
    ...(scoringPolicy?.penaltyRules.map((item) => item.id) ?? [])
  ];
  const dimensionNames = schema.dimensions.map((dimension) => dimension.name);
  const dimensionTotal = schema.dimensions.reduce(
    (total, dimension) => total + dimension.maxScore,
    0
  );
  const scoreTotalIsValid = scoringPolicy
    ? dimensionTotal === scoringPolicy.baseMaxScore &&
      scoringPolicy.normalization.rawMaxScore ===
        scoringPolicy.baseMaxScore +
          scoringPolicy.bonusRules.reduce(
            (total, rule) => total + rule.maxScore,
            0
          )
    : dimensionTotal === 100;

  return (
    referencedIds.every((id) => requirementIds.has(id)) &&
    [...requirementIds].every((id) => mappedIds.has(id)) &&
    new Set(allIds).size === allIds.length &&
    new Set(dimensionNames).size === dimensionNames.length &&
    scoreTotalIsValid
  );
}

const sourceRequirementKinds = new Set<SourceRequirementKind>([
  "dimension",
  "criterion",
  "pitfall",
  "score",
  "global"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isSourceRequirement(value: unknown): value is SourceRequirement {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.text) &&
    typeof value.kind === "string" &&
    sourceRequirementKinds.has(value.kind as SourceRequirementKind)
  );
}

function isMappedTextItem(
  value: unknown
): value is RubricCriterion | RubricPitfall | RubricGlobalConstraint {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.text) &&
    isNonEmptyStringArray(value.sourceRequirementIds)
  );
}

function isDimension(value: unknown): value is RubricDimensionV2 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    Number.isInteger(value.maxScore) &&
    (value.maxScore as number) > 0 &&
    isNonEmptyStringArray(value.sourceRequirementIds) &&
    Array.isArray(value.criteria) &&
    value.criteria.length > 0 &&
    value.criteria.every(isMappedTextItem) &&
    Array.isArray(value.pitfalls) &&
    value.pitfalls.length > 0 &&
    value.pitfalls.every(isMappedTextItem)
  );
}

const penaltyEffects = new Set<RubricPenaltyEffect>([
  "deduct",
  "cap",
  "set_range",
  "veto",
  "qualitative"
]);

function isScoringPolicy(value: unknown): value is RubricScoringPolicy {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "mode",
      "baseMaxScore",
      "bonusRules",
      "penaltyRules",
      "scoreConflicts",
      "normalization"
    ]) ||
    value.mode !== "normalized_rules" ||
    !isPositiveInteger(value.baseMaxScore) ||
    !Array.isArray(value.bonusRules) ||
    !value.bonusRules.every(isBonusRule) ||
    !Array.isArray(value.penaltyRules) ||
    !value.penaltyRules.every(isPenaltyRule) ||
    !Array.isArray(value.scoreConflicts) ||
    !value.scoreConflicts.every(isScoreConflict) ||
    !isNormalization(value.normalization)
  ) {
    return false;
  }
  return true;
}

function isBonusRule(value: unknown): value is RubricBonusRule {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "text",
      "minScore",
      "maxScore",
      "sourceRequirementIds"
    ]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.text) &&
    isNonNegativeInteger(value.minScore) &&
    isPositiveInteger(value.maxScore) &&
    value.minScore <= value.maxScore &&
    isNonEmptyStringArray(value.sourceRequirementIds)
  );
}

function isPenaltyRule(value: unknown): value is RubricPenaltyRule {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "text",
      "effect",
      "score",
      "minScore",
      "maxScore",
      "sourceRequirementIds"
    ]) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.text) ||
    typeof value.effect !== "string" ||
    !penaltyEffects.has(value.effect as RubricPenaltyEffect) ||
    !isOptionalPositiveInteger(value.score) ||
    !isOptionalBoundedScore(value.minScore) ||
    !isOptionalBoundedScore(value.maxScore) ||
    !isNonEmptyStringArray(value.sourceRequirementIds)
  ) {
    return false;
  }

  if (value.effect === "deduct") {
    return isPositiveInteger(value.score);
  }
  if (value.effect === "cap") {
    return isBoundedScore(value.maxScore);
  }
  if (value.effect === "set_range") {
    return (
      isBoundedScore(value.minScore) &&
      isBoundedScore(value.maxScore) &&
      value.minScore <= value.maxScore
    );
  }
  return true;
}

function isScoreConflict(value: unknown): value is RubricScoreConflict {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["text", "sourceRequirementIds"]) &&
    isNonEmptyString(value.text) &&
    isNonEmptyStringArray(value.sourceRequirementIds) &&
    new Set(value.sourceRequirementIds).size >= 2
  );
}

function isNormalization(value: unknown): value is RubricNormalization {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["rawMaxScore", "targetMaxScore", "method"]) &&
    isPositiveInteger(value.rawMaxScore) &&
    value.targetMaxScore === 100 &&
    value.method === "linear"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isBoundedScore(value: unknown): value is number {
  return (
    isNonNegativeInteger(value) && (value as number) <= 100
  );
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value == null || isPositiveInteger(value);
}

function isOptionalBoundedScore(value: unknown): boolean {
  return value == null || isBoundedScore(value);
}

function isCompilationMetadata(
  value: unknown
): value is RubricSchemaV2["compilation"] {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.compilerModel) &&
    isNonEmptyString(value.auditorModel) &&
    value.coveragePassed === true &&
    typeof value.inferredScores === "boolean"
  );
}
