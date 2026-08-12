import json
import os
from typing import Any, Optional

import httpx
from pydantic import ValidationError

from app.models import (
    CompileRubricRequest,
    CompileRubricResponse,
    CoverageAuditResult,
    RubricSchemaV2,
)
from app.services.rubric_schema import (
    RubricSchemaValidationError,
    validate_rubric_schema,
)


DEFAULT_OPENAI_TIMEOUT_SECONDS = 180


class RubricCompilationError(RuntimeError):
    def __init__(
        self,
        stage: str,
        code: str,
        message: str,
        details: Optional[dict] = None,
    ):
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message
        self.details = details or {}

    def as_dict(self) -> dict:
        return {
            "stage": self.stage,
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }


async def compile_rubric(request: CompileRubricRequest) -> CompileRubricResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for rubric compilation.")

    return await _compile_with_openai(request, api_key)


async def _compile_with_openai(
    request: CompileRubricRequest, api_key: str
) -> CompileRubricResponse:
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    async with httpx.AsyncClient(timeout=_openai_timeout_seconds()) as client:
        schema = await _run_compile_stage(
            "compiling_schema",
            _compile_candidate(client, base_url, model, api_key, request),
        )
        repair_used = False

        try:
            validate_rubric_schema(schema)
        except RubricSchemaValidationError as error:
            schema = await _run_compile_stage(
                "repairing_schema",
                _repair_candidate(
                    client,
                    base_url,
                    model,
                    api_key,
                    request,
                    schema,
                    {"code": error.code, "details": error.details},
                ),
            )
            repair_used = True
            _validate_repaired_schema(schema)

        audit_stage = (
            "auditing_repaired_schema" if repair_used else "auditing_coverage"
        )
        audit = await _run_compile_stage(
            audit_stage,
            _audit_candidate(client, base_url, model, api_key, request, schema),
        )
        _validate_audit_result(audit_stage, audit)
        if not audit.passed:
            if repair_used:
                raise _coverage_failure("auditing_repaired_schema", audit)

            schema = await _run_compile_stage(
                "repairing_schema",
                _repair_candidate(
                    client,
                    base_url,
                    model,
                    api_key,
                    request,
                    schema,
                    audit.model_dump(),
                ),
            )
            repair_used = True
            _validate_repaired_schema(schema)
            audit = await _run_compile_stage(
                "auditing_repaired_schema",
                _audit_candidate(
                    client, base_url, model, api_key, request, schema
                ),
            )
            _validate_audit_result("auditing_repaired_schema", audit)
            if not audit.passed:
                raise _coverage_failure("auditing_repaired_schema", audit)

    schema.compilation.compiler_model = model
    schema.compilation.auditor_model = model
    schema.compilation.coverage_passed = True
    return CompileRubricResponse(
        rubric_schema=schema,
        compiler_model=model,
        auditor_model=model,
    )


async def _compile_candidate(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
) -> RubricSchemaV2:
    data = await _post_json_completion(
        client,
        base_url,
        model,
        api_key,
        _build_compile_prompt(request),
        "你是公务员面试评分标准编译器。",
    )
    schema = RubricSchemaV2.model_validate(data)
    schema.compilation.compiler_model = model
    schema.compilation.auditor_model = None
    schema.compilation.coverage_passed = False
    return schema


async def _audit_candidate(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
    schema: RubricSchemaV2,
) -> CoverageAuditResult:
    data = await _post_json_completion(
        client,
        base_url,
        model,
        api_key,
        _build_audit_prompt(request, schema),
        "你是独立的评分标准覆盖审计员，只以用户原始评分标准为依据。",
    )
    return CoverageAuditResult.model_validate(data)


async def _repair_candidate(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
    schema: RubricSchemaV2,
    errors: dict,
) -> RubricSchemaV2:
    data = await _post_json_completion(
        client,
        base_url,
        model,
        api_key,
        _build_repair_prompt(request, schema, errors),
        "你是评分标准 Schema 定向修复器，只修复报告指出的问题。",
    )
    repaired = RubricSchemaV2.model_validate(data)
    repaired.compilation.compiler_model = model
    repaired.compilation.auditor_model = None
    repaired.compilation.coverage_passed = False
    return repaired


async def _post_json_completion(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    prompt: str,
    system_prompt: str,
) -> dict[str, Any]:
    response = await client.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        },
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    return json.loads(content)


def _build_compile_prompt(request: CompileRubricRequest) -> str:
    return (
        "请一次完成原子要求提取与 RubricSchema v2 编译，只输出完整 JSON，不要解释。\n"
        "必须返回 version=v2、role_prompt、source_requirements、global_constraints、dimensions、"
        "answer_principles、retry_policy、output_rules 和 compilation。\n"
        "source_requirements 的 kind 只能是 dimension、criterion、pitfall、score、global；"
        "每条原子要求必须通过 source_requirement_ids 映射到维度、criterion、pitfall 或全局约束。\n"
        "每个维度必须有稳定 DIM ID、唯一非空名称、正整数 max_score、至少一个 criterion 和 pitfall；"
        "criterion 与 pitfall 使用稳定 CRI/PIT ID 且必须映射来源。所有维度分值总和必须为 100。\n"
        "原文完全没有分值时才可推断权重并设置 inferred_scores=true；部分分值、冲突分值或"
        "明确分值总和有歧义时不得静默补全。coverage_passed 必须为 false，auditor_model 必须为 null。\n"
        "档位描述中的重复表达应归并，不得把优/良/中/差本身提取成维度；不得新增原文不支持的业务要求。\n\n"
        f"答题时间：{request.answer_minutes} 分钟\n"
        "通过分数仅用于生成后的运行判断，不得提取为原子要求，也不得用于维度权重推断。\n"
        f"原始评分标准：\n{request.rubric}"
    )


def _build_audit_prompt(
    request: CompileRubricRequest, schema: RubricSchemaV2
) -> str:
    return (
        "请独立审计候选 Schema 是否完整、忠实地覆盖原始评分标准。只输出 CoverageAuditResult JSON。\n"
        "不得沿用编译器结论；逐项检查遗漏、无原文依据的新增内容、语义弱化和分值问题。"
        "原文完全无分值时才允许 inferred_scores=true；原文部分有分值、分值冲突或明确分值总和不正确时"
        "必须写入 score_issues。\n"
        "确定性校验摘要：候选 Schema 的 ID、引用、映射和 100 分总分校验已通过。\n\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"提取出的原子要求：\n{json.dumps([item.model_dump() for item in schema.source_requirements], ensure_ascii=False)}\n\n"
        f"候选 Schema：\n{schema.model_dump_json()}"
    )


def _build_repair_prompt(
    request: CompileRubricRequest, schema: RubricSchemaV2, errors: dict
) -> str:
    return (
        "只修复校验或审计报告指出的问题，保留其余已验证内容。输出完整 RubricSchema v2 JSON。\n"
        "不得新增修复报告未要求的业务规则；coverage_passed 必须保持 false。\n\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"候选 Schema：\n{schema.model_dump_json()}\n\n"
        f"修复报告：\n{json.dumps(errors, ensure_ascii=False)}"
    )


async def _run_compile_stage(stage: str, operation):
    try:
        return await operation
    except RubricCompilationError:
        raise
    except httpx.TimeoutException as error:
        raise RubricCompilationError(
            stage,
            "AI_SERVICE_TIMEOUT",
            "评分标准分析模型调用超时",
            {"error": str(error)},
        ) from error
    except httpx.HTTPError as error:
        raise RubricCompilationError(
            stage,
            "AI_SERVICE_ERROR",
            "评分标准分析模型调用失败",
            {"error": str(error)},
        ) from error
    except (json.JSONDecodeError, ValidationError, KeyError, IndexError, TypeError) as error:
        raise RubricCompilationError(
            stage,
            "INVALID_MODEL_RESPONSE",
            "评分标准分析模型返回了无法解析的内容",
            {"error": str(error)},
        ) from error


def _validate_repaired_schema(schema: RubricSchemaV2) -> None:
    try:
        validate_rubric_schema(schema)
    except RubricSchemaValidationError as error:
        raise RubricCompilationError(
            "validating_schema",
            error.code,
            "修复后的评分标准仍未通过确定性校验",
            error.details,
        ) from error


def _coverage_failure(
    stage: str, audit: CoverageAuditResult
) -> RubricCompilationError:
    return RubricCompilationError(
        stage,
        "COVERAGE_AUDIT_FAILED",
        "评分标准覆盖审计失败",
        audit.model_dump(),
    )


def _validate_audit_result(stage: str, audit: CoverageAuditResult) -> None:
    reported_issues = bool(
        audit.missing_requirement_ids
        or audit.unsupported_schema_paths
        or audit.conflicts
        or audit.score_issues
        or audit.repair_instructions
    )
    if audit.passed == reported_issues:
        raise RubricCompilationError(
            stage,
            "INVALID_MODEL_RESPONSE",
            "覆盖审计结论与问题明细相互矛盾",
            audit.model_dump(),
        )


def _openai_timeout_seconds() -> int:
    raw_value = os.getenv("OPENAI_TIMEOUT_SECONDS")
    if not raw_value:
        return DEFAULT_OPENAI_TIMEOUT_SECONDS

    try:
        timeout = int(raw_value)
    except ValueError:
        return DEFAULT_OPENAI_TIMEOUT_SECONDS

    return timeout if timeout > 0 else DEFAULT_OPENAI_TIMEOUT_SECONDS
