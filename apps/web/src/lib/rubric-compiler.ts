import {
  isVerifiedRubricSchemaV2,
  type RubricCompilationState,
  type RubricSchemaV2
} from "@answer-generator/shared";

interface ApiRubricSchemaV2 {
  version: "v2";
  role_prompt: string;
  source_requirements: Array<{
    id: string;
    text: string;
    kind: "dimension" | "criterion" | "pitfall" | "score" | "global";
  }>;
  global_constraints: Array<{
    id: string;
    text: string;
    source_requirement_ids: string[];
  }>;
  dimensions: Array<{
    id: string;
    name: string;
    max_score: number;
    source_requirement_ids: string[];
    criteria: Array<{
      id: string;
      text: string;
      source_requirement_ids: string[];
    }>;
    pitfalls: Array<{
      id: string;
      text: string;
      source_requirement_ids: string[];
    }>;
  }>;
  answer_principles: string[];
  retry_policy: string[];
  output_rules: string[];
  compilation: {
    compiler_model: string;
    auditor_model: string | null;
    coverage_passed: boolean;
    inferred_scores: boolean;
  };
}

interface CompileRubricResponse {
  rubric_schema: ApiRubricSchemaV2;
  compiler_model: string;
  auditor_model: string;
}

interface CompileRubricErrorPayload {
  detail?: {
    stage?: unknown;
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
}

export interface CompiledRubricResult {
  rubricSchema: RubricSchemaV2;
  compilation: RubricCompilationState;
}

export class RubricCompilationRequestError extends Error {
  constructor(public readonly compilation: RubricCompilationState) {
    super(compilation.message ?? "评分标准分析失败");
    this.name = "RubricCompilationRequestError";
  }
}

export async function compileRubricForJob(input: {
  rubric: string;
  answerMinutes: number;
  passingScore: number;
}): Promise<CompiledRubricResult> {
  const aiServiceUrl = process.env.AI_SERVICE_URL ?? "http://localhost:8001";

  const response = await fetch(`${aiServiceUrl}/ai/compile-rubric`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rubric: input.rubric,
      answer_minutes: input.answerMinutes,
      passing_score: input.passingScore
    })
  });

  if (!response.ok) {
    throw new RubricCompilationRequestError(
      await compilationFailureFromResponse(response)
    );
  }

  let payload: CompileRubricResponse;
  let rubricSchema: RubricSchemaV2;
  try {
    const value: unknown = await response.json();
    if (!isCompileRubricResponse(value)) {
      throw new Error("Invalid compile response shape");
    }
    payload = value;
    rubricSchema = toCamelSchema(payload.rubric_schema);
  } catch (error) {
    throw new RubricCompilationRequestError({
      stage: "failed",
      code: "INVALID_MODEL_RESPONSE",
      message: "评分标准分析服务返回了无效的评分规则",
      details: {
        error: error instanceof Error ? error.message : "Unknown response error"
      },
      updatedAt: new Date().toISOString()
    });
  }
  if (!isVerifiedRubricSchemaV2(rubricSchema)) {
    throw new RubricCompilationRequestError({
      stage: "failed",
      code: "INVALID_MODEL_RESPONSE",
      message: "评分标准分析服务返回了无效的评分规则",
      updatedAt: new Date().toISOString()
    });
  }

  return {
    rubricSchema,
    compilation: {
      stage: "completed",
      compilerModel: payload.compiler_model,
      auditorModel: payload.auditor_model,
      updatedAt: new Date().toISOString()
    }
  };
}

async function compilationFailureFromResponse(
  response: Response
): Promise<RubricCompilationState> {
  const responseText = await response.text();
  let payload: CompileRubricErrorPayload | null = null;
  try {
    payload = JSON.parse(responseText) as CompileRubricErrorPayload;
  } catch {
    payload = null;
  }

  const detail = payload?.detail;
  if (
    detail &&
    typeof detail.stage === "string" &&
    typeof detail.code === "string" &&
    typeof detail.message === "string"
  ) {
    return {
      stage: detail.stage,
      code: detail.code,
      message: detail.message,
      details: isRecord(detail.details) ? detail.details : undefined,
      updatedAt: new Date().toISOString()
    };
  }

  return {
    stage: "failed",
    code: "AI_SERVICE_ERROR",
    message: responseText || "评分标准分析失败",
    updatedAt: new Date().toISOString()
  };
}

function toCamelSchema(schema: ApiRubricSchemaV2): RubricSchemaV2 {
  return {
    version: schema.version,
    rolePrompt: schema.role_prompt,
    sourceRequirements: schema.source_requirements.map((requirement) => ({
      id: requirement.id,
      text: requirement.text,
      kind: requirement.kind
    })),
    globalConstraints: schema.global_constraints.map((constraint) => ({
      id: constraint.id,
      text: constraint.text,
      sourceRequirementIds: constraint.source_requirement_ids
    })),
    dimensions: schema.dimensions.map((dimension) => ({
      id: dimension.id,
      name: dimension.name,
      maxScore: dimension.max_score,
      sourceRequirementIds: dimension.source_requirement_ids,
      criteria: dimension.criteria.map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        sourceRequirementIds: criterion.source_requirement_ids
      })),
      pitfalls: dimension.pitfalls.map((pitfall) => ({
        id: pitfall.id,
        text: pitfall.text,
        sourceRequirementIds: pitfall.source_requirement_ids
      }))
    })),
    answerPrinciples: schema.answer_principles,
    retryPolicy: schema.retry_policy,
    outputRules: schema.output_rules,
    compilation: {
      compilerModel: schema.compilation.compiler_model,
      auditorModel: schema.compilation.auditor_model,
      coveragePassed: schema.compilation.coverage_passed,
      inferredScores: schema.compilation.inferred_scores
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCompileRubricResponse(value: unknown): value is CompileRubricResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.compiler_model === "string" &&
    value.compiler_model.trim().length > 0 &&
    typeof value.auditor_model === "string" &&
    value.auditor_model.trim().length > 0 &&
    isApiRubricSchemaV2(value.rubric_schema)
  );
}

function isApiRubricSchemaV2(value: unknown): value is ApiRubricSchemaV2 {
  if (!isRecord(value) || !isRecord(value.compilation)) {
    return false;
  }
  return (
    value.version === "v2" &&
    typeof value.role_prompt === "string" &&
    Array.isArray(value.source_requirements) &&
    value.source_requirements.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === "string" &&
        typeof item.text === "string" &&
        typeof item.kind === "string"
    ) &&
    Array.isArray(value.global_constraints) &&
    value.global_constraints.every(isApiMappedItem) &&
    Array.isArray(value.dimensions) &&
    value.dimensions.every(isApiDimension) &&
    isStringArray(value.answer_principles) &&
    isStringArray(value.retry_policy) &&
    isStringArray(value.output_rules) &&
    typeof value.compilation.compiler_model === "string" &&
    (typeof value.compilation.auditor_model === "string" ||
      value.compilation.auditor_model === null) &&
    typeof value.compilation.coverage_passed === "boolean" &&
    typeof value.compilation.inferred_scores === "boolean"
  );
}

function isApiMappedItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    isStringArray(value.source_requirement_ids)
  );
}

function isApiDimension(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.max_score === "number" &&
    isStringArray(value.source_requirement_ids) &&
    Array.isArray(value.criteria) &&
    value.criteria.every(isApiMappedItem) &&
    Array.isArray(value.pitfalls) &&
    value.pitfalls.every(isApiMappedItem)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
