import assert from "node:assert/strict";
import test from "node:test";
import { compilationErrorView } from "../src/components/dashboard/utils";

test("restores a persisted rubric compilation failure", () => {
  assert.deepEqual(
    compilationErrorView({
      stage: "compiling_schema",
      code: "INVALID_MODEL_RESPONSE",
      message: "评分标准分析模型返回了无法解析的内容",
      details: { error: "dimensions: List should have at least 1 item" },
      updatedAt: "2026-08-14T08:03:43.688Z"
    }),
    {
      title: "评分标准分析失败",
      message: "评分标准分析模型返回了无法解析的内容",
      meta: "compiling_schema · INVALID_MODEL_RESPONSE",
      technicalDetails: "dimensions: List should have at least 1 item"
    }
  );
});

test("does not show in-progress or completed compilation as an error", () => {
  assert.equal(
    compilationErrorView({
      stage: "compiling_schema",
      updatedAt: "2026-08-14T08:03:43.688Z"
    }),
    null
  );
  assert.equal(
    compilationErrorView({
      stage: "completed",
      updatedAt: "2026-08-14T08:03:43.688Z"
    }),
    null
  );
});

test("omits non-string technical details", () => {
  assert.equal(
    compilationErrorView({
      stage: "failed",
      code: "AI_SERVICE_ERROR",
      message: "评分标准分析失败",
      details: { retryable: false },
      updatedAt: "2026-08-14T08:03:43.688Z"
    })?.technicalDetails,
    null
  );
});
