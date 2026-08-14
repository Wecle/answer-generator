import json
import os
from typing import Any, Optional

import httpx
from pydantic import ValidationError

from app.models import (
    CompileRubricRequest,
    CompileRubricResponse,
    CoverageAuditResult,
    RubricSchemaCandidate,
    RubricSchemaV2,
    build_rubric_schema,
)
from app.services.rubric_schema import (
    RubricSchemaValidationError,
    validate_rubric_schema,
)
from app.services.structured_output import post_structured_completion


DEFAULT_OPENAI_TIMEOUT_SECONDS = 180
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"


def _rubric_compiler_model() -> str:
    compiler_model = os.getenv("RUBRIC_COMPILER_MODEL", "").strip()
    if compiler_model:
        return compiler_model

    shared_model = os.getenv("OPENAI_MODEL", "").strip()
    return shared_model or DEFAULT_OPENAI_MODEL


RUBRIC_CANDIDATE_EXAMPLE = {
    "version": "v2",
    "role_prompt": "你是一名参加公务员结构化面试的考生。",
    "source_requirements": [
        {"id": "REQ-001", "text": "准确分析问题", "kind": "criterion"}
    ],
    "global_constraints": [],
    "dimensions": [
        {
            "id": "DIM-001",
            "name": "综合分析能力",
            "max_score": 100,
            "source_requirement_ids": ["REQ-001"],
            "criteria": [
                {
                    "id": "CRI-001",
                    "text": "准确分析问题",
                    "source_requirement_ids": ["REQ-001"],
                }
            ],
            "pitfalls": [
                {
                    "id": "PIT-001",
                    "text": "只表态不分析",
                    "source_requirement_ids": ["REQ-001"],
                }
            ],
        }
    ],
    "scoring_policy": None,
    "answer_principles": ["围绕题目作答"],
    "retry_policy": ["定向修复低分项"],
    "output_rules": ["输出纯文本"],
    "inferred_scores": False,
}

RUBRIC_NORMALIZED_POLICY_EXAMPLE = {
    "mode": "normalized_rules",
    "base_max_score": 75,
    "bonus_rules": [
        {
            "id": "BONUS-001",
            "text": "有画面可加2-4分",
            "min_score": 2,
            "max_score": 4,
            "source_requirement_ids": ["REQ-003"],
        },
        {
            "id": "BONUS-002",
            "text": "有人味儿可加2-3分",
            "min_score": 2,
            "max_score": 3,
            "source_requirement_ids": ["REQ-004"],
        },
    ],
    "penalty_rules": [
        {
            "id": "PEN-001",
            "text": "答非所问掉到60-70分",
            "effect": "set_range",
            "score": None,
            "min_score": 60,
            "max_score": 70,
            "source_requirement_ids": ["REQ-005"],
        },
        {
            "id": "PEN-002",
            "text": "超时印象分大扣",
            "effect": "qualitative",
            "score": None,
            "min_score": None,
            "max_score": None,
            "source_requirement_ids": ["REQ-006"],
        },
    ],
    "score_conflicts": [
        {
            "text": "档位标题与逐项上限不一致",
            "source_requirement_ids": ["REQ-003", "REQ-004"],
        }
    ],
    "normalization": {
        "raw_max_score": 82,
        "target_max_score": 100,
        "method": "linear",
    },
}


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
    model = _rubric_compiler_model()

    async with httpx.AsyncClient(timeout=_openai_timeout_seconds()) as client:
        candidate_data = await _run_compile_stage(
            "compiling_schema",
            _compile_candidate_data(client, base_url, model, api_key, request),
        )
        repair_used = False
        try:
            candidate = RubricSchemaCandidate.model_validate(candidate_data)
        except ValidationError as error:
            candidate = await _run_compile_stage(
                "repairing_schema",
                _repair_invalid_candidate(
                    client,
                    base_url,
                    model,
                    api_key,
                    request,
                    candidate_data,
                    error,
                ),
            )
            repair_used = True

        schema = build_rubric_schema(candidate, model)

        try:
            validate_rubric_schema(schema)
        except RubricSchemaValidationError as error:
            if repair_used:
                raise RubricCompilationError(
                    "validating_schema",
                    error.code,
                    "评分标准结构修复后仍未通过确定性校验",
                    error.details,
                ) from error
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


async def _compile_candidate_data(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
) -> dict[str, Any]:
    return await post_structured_completion(
        client=client,
        base_url=base_url,
        model=model,
        api_key=api_key,
        prompt=_build_compile_prompt(request),
        system_prompt="你是公务员面试评分标准编译器。",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="提交完整且可验证的评分标准候选结构。",
    )


async def _audit_candidate(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
    schema: RubricSchemaV2,
) -> CoverageAuditResult:
    data = await post_structured_completion(
        client=client,
        base_url=base_url,
        model=model,
        api_key=api_key,
        prompt=_build_audit_prompt(request, schema),
        system_prompt="你是独立的评分标准覆盖审计员，只以用户原始评分标准为依据。",
        output_model=CoverageAuditResult,
        function_name="submit_coverage_audit",
        function_description="提交评分标准覆盖审计结果。",
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
    data = await post_structured_completion(
        client=client,
        base_url=base_url,
        model=model,
        api_key=api_key,
        prompt=_build_repair_prompt(request, schema, errors),
        system_prompt="你是评分标准 Schema 定向修复器，只修复报告指出的问题。",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="提交修复后的完整评分标准候选结构。",
    )
    candidate = RubricSchemaCandidate.model_validate(data)
    return build_rubric_schema(candidate, model)


async def _repair_invalid_candidate(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
    candidate_data: dict[str, Any],
    error: ValidationError,
) -> RubricSchemaCandidate:
    repaired_data = await post_structured_completion(
        client=client,
        base_url=base_url,
        model=model,
        api_key=api_key,
        prompt=_build_structure_repair_prompt(
            request, candidate_data, error.errors(include_url=False)
        ),
        system_prompt="你是评分标准 Schema 结构修复器，只修复报告指出的问题。",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="提交修复后的完整评分标准候选结构。",
    )
    return RubricSchemaCandidate.model_validate(repaired_data)


def _build_compile_prompt(request: CompileRubricRequest) -> str:
    return (
        "请一次完成原子要求提取与 RubricSchema v2 编译，只输出完整 JSON，不要解释。\n"
        "必须返回 version=v2、role_prompt、source_requirements、global_constraints、dimensions、"
        "scoring_policy、answer_principles、retry_policy、output_rules 和 inferred_scores。\n"
        "source_requirements 的 kind 只能是 dimension、criterion、pitfall、score、global；"
        "每条原子要求必须通过 source_requirement_ids 映射到维度、criterion、pitfall、全局约束、"
        "bonus_rules、penalty_rules 或 score_conflicts。\n"
        "每个维度必须有稳定 DIM ID、唯一非空名称、正整数 max_score、至少一个 criterion 和 pitfall；"
        "criterion 与 pitfall 使用稳定 CRI/PIT ID 且必须映射来源。\n"
        "固定分合计明确为100时，scoring_policy返回null，所有维度分值总和必须为100。"
        "原文完全没有分值时也返回null，将维度权重推断为合计100并设置inferred_scores=true。"
        "存在基础分、区间加分、扣分、掉档、封顶或否决时，必须返回normalized_rules。\n"
        "不得把区间加分合并成固定维度或为了凑100分推断固定权重。"
        "区间加分写入bonus_rules；扣分、掉档、封顶、否决和无数值定性规则写入penalty_rules。"
        "原文数值冲突必须同时保留双方，并写入score_conflicts。"
        "raw_max_score必须等于base_max_score加所有bonus_rules.max_score。\n"
        "penalty effect 只能是 deduct、cap、set_range、veto、qualitative：deduct使用score，"
        "cap使用max_score，set_range使用min_score和max_score，veto与qualitative的数值字段返回null。"
        "normalization的target_max_score必须为100，method必须为linear。\n"
        "原文完全没有分值时才可推断权重并设置 inferred_scores=true；部分分值、冲突分值或"
        "明确分值总和有歧义时不得静默补全。\n"
        "只返回候选业务字段；不要返回 compilation。inferred_scores 必须是布尔值。\n"
        "档位描述中的重复表达应归并，不得把优/良/中/差本身提取成维度；不得新增原文不支持的业务要求。\n\n"
        f"完整 JSON 形状示例：\n{json.dumps(RUBRIC_CANDIDATE_EXAMPLE, ensure_ascii=False)}\n\n"
        "normalized_rules 的 scoring_policy 完整形状示例：\n"
        f"{json.dumps(RUBRIC_NORMALIZED_POLICY_EXAMPLE, ensure_ascii=False)}\n\n"
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
        "原文完全无分值时才允许 inferred_scores=true；原文部分有分值却被静默补全、明确分值总和不正确，"
        "或分值冲突未完整记录时，必须写入 score_issues。原文冲突双方均通过 source_requirement_ids "
        "完整映射到同一条 score_conflicts 时，应视为已忠实保存，不得仅因冲突存在判定失败。\n"
        "逐项检查固定维度、bonus_rules 和 penalty_rules 是否分别映射原文，区间端点是否忠实，"
        "不得接受把区间加分合并成固定维度，也不得接受把扣分、掉档、封顶、否决或定性规则只藏在 pitfall 文本中。"
        "检查 normalization 是否能由 base_max_score 与 bonus_rules 的上限确定性计算。\n"
        "确定性校验摘要：候选 Schema 的 ID、引用、映射以及固定100分或 normalized_rules 分值校验已通过。\n\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"提取出的原子要求：\n{json.dumps([item.model_dump() for item in schema.source_requirements], ensure_ascii=False)}\n\n"
        f"候选 Schema：\n{schema.model_dump_json()}"
    )


def _build_repair_prompt(
    request: CompileRubricRequest, schema: RubricSchemaV2, errors: dict
) -> str:
    return (
        "只修复校验或审计报告指出的问题，保留其余已验证内容。输出完整候选 JSON。\n"
        "不得新增修复报告未要求的业务规则；不要返回 compilation。必须保留 scoring_policy，"
        "不得将 normalized_rules 改回固定100分，也不得合并区间加分或弱化 penalty_rules。\n\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"候选 Schema：\n{schema.model_dump_json()}\n\n"
        f"修复报告：\n{json.dumps(errors, ensure_ascii=False)}"
    )


def _build_structure_repair_prompt(
    request: CompileRubricRequest,
    candidate_data: dict[str, Any],
    errors: list[dict[str, Any]],
) -> str:
    return (
        "只修复结构校验报告指出的问题，输出完整候选 JSON，不要返回 compilation。"
        "必须保留 scoring_policy，不得将 normalized_rules 改回固定100分，"
        "也不得合并区间加分或弱化 penalty_rules。\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"无效候选 JSON：\n{json.dumps(candidate_data, ensure_ascii=False)}\n\n"
        f"Pydantic 结构错误：\n{json.dumps(errors, ensure_ascii=False)}\n\n"
        f"完整 JSON 形状示例：\n{json.dumps(RUBRIC_CANDIDATE_EXAMPLE, ensure_ascii=False)}\n\n"
        "normalized_rules 的 scoring_policy 完整形状示例：\n"
        f"{json.dumps(RUBRIC_NORMALIZED_POLICY_EXAMPLE, ensure_ascii=False)}"
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
        details = {"error": str(error)}
        if isinstance(error, httpx.HTTPStatusError):
            details["status_code"] = error.response.status_code
            details["response_body"] = error.response.text[:4000]
        raise RubricCompilationError(
            stage,
            "AI_SERVICE_ERROR",
            "评分标准分析模型调用失败",
            details,
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
