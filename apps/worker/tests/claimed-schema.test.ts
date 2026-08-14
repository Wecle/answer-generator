import assert from "node:assert/strict";
import test from "node:test";
import type { PersistedRubricSchema } from "@answer-generator/shared";
import { verifyClaimedRubricSchema } from "../src/claimed-schema";
import { verifiedSchemaFixture } from "./fixtures";

test("verified claimed schema proceeds without failing the job", async () => {
  let failureCalls = 0;
  const schema = await verifyClaimedRubricSchema(
    verifiedSchemaFixture,
    "compilation-1",
    async () => {
      failureCalls += 1;
    }
  );

  assert.equal(schema, verifiedSchemaFixture);
  assert.equal(failureCalls, 0);
});

for (const [name, schema] of [
  ["missing", null],
  [
    "v1",
    {
      rolePrompt: "旧版",
      answerPrinciples: [],
      dimensions: [],
      retryPolicy: [],
      outputRules: []
    }
  ],
  [
    "unverified v2",
    {
      ...verifiedSchemaFixture,
      compilation: {
        ...verifiedSchemaFixture.compilation,
        coveragePassed: false
      }
    }
  ]
] as Array<[string, PersistedRubricSchema | null]>) {
  test(`${name} claimed schema transitions to an actionable failure`, async () => {
    const failures: Array<Record<string, unknown>> = [];
    const result = await verifyClaimedRubricSchema(
      schema,
      "compilation-1",
      async (failure) => {
        failures.push(failure);
      }
    );

    assert.equal(result, null);
    assert.deepEqual(failures, [
      {
        stage: "validating_schema_for_generation",
        code: "RUBRIC_SCHEMA_NOT_VERIFIED",
        message: "任务缺少已审计通过的 Rubric Schema v2",
        details: {
          compilationId: "compilation-1",
          receivedSchemaVersion:
            schema && "version" in schema ? schema.version : schema ? "v1" : null,
          coveragePassed:
            schema && "version" in schema
              ? schema.compilation.coveragePassed
              : false
        }
      }
    ]);
  });
}
