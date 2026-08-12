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

export interface RubricSchemaV2 {
  version: "v2";
  rolePrompt: string;
  sourceRequirements: SourceRequirement[];
  globalConstraints: RubricGlobalConstraint[];
  dimensions: RubricDimensionV2[];
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
  const mappedItems = [
    ...schema.globalConstraints,
    ...schema.dimensions,
    ...schema.dimensions.flatMap((dimension) => [
      ...dimension.criteria,
      ...dimension.pitfalls
    ])
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
    )
  ];
  const dimensionNames = schema.dimensions.map((dimension) => dimension.name);

  return (
    referencedIds.every((id) => requirementIds.has(id)) &&
    [...requirementIds].every((id) => mappedIds.has(id)) &&
    new Set(allIds).size === allIds.length &&
    new Set(dimensionNames).size === dimensionNames.length &&
    schema.dimensions.reduce(
      (total, dimension) => total + dimension.maxScore,
      0
    ) === 100
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
  return Boolean(value) && typeof value === "object";
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
