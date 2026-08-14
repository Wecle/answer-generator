import {
  isVerifiedRubricSchemaV2,
  type PersistedRubricSchema,
  type RubricCompilationState,
  type RubricSchemaV2
} from "@answer-generator/shared";

export type ClaimedSchemaFailure = Omit<
  RubricCompilationState,
  "updatedAt"
>;

export async function verifyClaimedRubricSchema(
  schema: PersistedRubricSchema | null,
  compilationId: string,
  failClaimedJob: (failure: ClaimedSchemaFailure) => Promise<void>
): Promise<RubricSchemaV2 | null> {
  if (isVerifiedRubricSchemaV2(schema)) {
    return schema;
  }

  await failClaimedJob({
    stage: "validating_schema_for_generation",
    code: "RUBRIC_SCHEMA_NOT_VERIFIED",
    message: "任务缺少已审计通过的 Rubric Schema v2",
    details: {
      compilationId,
      receivedSchemaVersion: getSchemaVersion(schema),
      coveragePassed: getCoveragePassed(schema)
    }
  });
  return null;
}

function getSchemaVersion(schema: PersistedRubricSchema | null) {
  if (!schema) {
    return null;
  }
  return (schema as Partial<RubricSchemaV2>).version === "v2" ? "v2" : "v1";
}

function getCoveragePassed(schema: PersistedRubricSchema | null) {
  if (!schema) {
    return false;
  }
  const candidate = schema as Partial<RubricSchemaV2>;
  return candidate.version === "v2" && candidate.compilation?.coveragePassed === true;
}
