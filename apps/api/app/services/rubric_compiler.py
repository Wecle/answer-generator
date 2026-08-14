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
MAX_SCHEMA_VALIDATION_REPAIRS = 3
MAX_COVERAGE_AUDIT_REPAIRS = 2


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

        schema, validation_repair_used = await _repair_until_valid(
            client, base_url, model, api_key, request, schema
        )
        repair_used = repair_used or validation_repair_used

        audit_stage = (
            "auditing_repaired_schema" if repair_used else "auditing_coverage"
        )
        audit = await _run_compile_stage(
            audit_stage,
            _audit_candidate(client, base_url, model, api_key, request, schema),
        )
        audit = _normalize_affirmative_audit(audit)
        _validate_audit_result(audit_stage, audit)
        audit_repairs = 0
        while not audit.passed:
            if audit_repairs >= MAX_COVERAGE_AUDIT_REPAIRS:
                raise _coverage_failure("auditing_repaired_schema", audit)
            audit_repairs += 1
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
            schema, _ = await _repair_until_valid(
                client, base_url, model, api_key, request, schema
            )
            audit = await _run_compile_stage(
                "auditing_repaired_schema",
                _audit_candidate(
                    client, base_url, model, api_key, request, schema
                ),
            )
            audit = _normalize_affirmative_audit(audit)
            _validate_audit_result("auditing_repaired_schema", audit)

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
    try:
        candidate = RubricSchemaCandidate.model_validate(data)
    except ValidationError as error:
        candidate = await _repair_invalid_candidate(
            client,
            base_url,
            model,
            api_key,
            request,
            data,
            error,
            repair_report=errors,
        )
    return build_rubric_schema(candidate, model)


async def _repair_invalid_candidate(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
    candidate_data: dict[str, Any],
    error: ValidationError,
    repair_report: Optional[dict] = None,
) -> RubricSchemaCandidate:
    repaired_data = await post_structured_completion(
        client=client,
        base_url=base_url,
        model=model,
        api_key=api_key,
        prompt=_build_structure_repair_prompt(
            request,
            candidate_data,
            error.errors(include_url=False),
            repair_report,
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
        "检查 normalization 是否能由 base_max_score 与 bonus_rules 的上限确定性计算。"
        "当档位标题上限与逐项加分上限冲突时，raw_max_score 应采用可逐项计算的 base_max_score 加"
        "bonus_rules.max_score 之和；只要冲突双方及区间端点已在 score_conflicts 中完整映射，就必须"
        "视为忠实保存，不得要求模型擅自选择标题上限、删除归一化或否定逐项加分可叠加。"
        "基础层的“保底”描述与明确的低分掉档规则并存时，应保留掉档规则；若两者已记录为冲突，"
        "不得仅因掉档低于基础满分而判定失败。target_max_score=100 是系统统一输出分制的固定契约，"
        "不是从原文提取出的业务分值；不得以原文未声明100分为由判定新增语义或要求删除归一化。"
        "normalized_rules 只会用于原文存在明确分值的情况，其 inferred_scores 必须为 false。\n"
        "score_issues 只能填写仍需修复的实际问题；已正确、符合原则或应视为忠实保存的观察不得写入"
        "score_issues。若没有实际问题，必须返回 passed=true 且所有问题与修复列表为空。\n"
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
        "不得将 normalized_rules 改回固定100分，也不得合并区间加分或弱化 penalty_rules。"
        "当错误是 INVALID_BASE_SCORE_TOTAL 时，dimensions.max_score 之和必须修正为 "
        "scoring_policy.base_max_score；raw_max_score 必须等于 base_max_score 加所有 "
        "bonus_rules.max_score。只保留原文基础层明确计分的维度；不得为了降低总分把多余维度设为0，"
        "非基础计分章节应删除其独立维度并将来源要求忠实重映射到 criterion、global constraint、"
        "bonus rule 或 penalty rule。当错误是 UNMAPPED_REQUIREMENT 时，必须逐个保留报告中的来源要求，"
        "并根据原文语义映射到合适的现有或新增 criterion、pitfall、global constraint、bonus rule、"
        "penalty rule 或 score conflict；不得通过删除 source_requirements 规避映射。返回前必须计算"
        "所有 source_requirements.id 与全部 source_requirement_ids 的差集，并确认差集为空。\n\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"候选 Schema：\n{schema.model_dump_json()}\n\n"
        f"修复报告：\n{json.dumps(errors, ensure_ascii=False)}"
    )


def _build_structure_repair_prompt(
    request: CompileRubricRequest,
    candidate_data: dict[str, Any],
    errors: list[dict[str, Any]],
    repair_report: Optional[dict] = None,
) -> str:
    repair_context = ""
    if repair_report is not None:
        repair_context = (
            "本候选来自上一轮定向修复，还必须同时满足上一轮修复报告；不得只修字段形状而重新引入"
            "原问题。不得用 max_score=0 保留多余维度；应按原始评分标准删除非基础计分维度并忠实"
            "重映射其来源要求。\n"
            f"上一轮修复报告：\n{json.dumps(repair_report, ensure_ascii=False)}\n\n"
        )
    return (
        "只修复结构校验报告指出的问题，输出完整候选 JSON，不要返回 compilation。"
        "必须保留 scoring_policy，不得将 normalized_rules 改回固定100分，"
        "也不得合并区间加分或弱化 penalty_rules。\n"
        f"{repair_context}"
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


async def _repair_until_valid(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    request: CompileRubricRequest,
    schema: RubricSchemaV2,
) -> tuple[RubricSchemaV2, bool]:
    repair_used = False
    validation_repairs = 0
    while True:
        try:
            validate_rubric_schema(schema)
            return schema, repair_used
        except RubricSchemaValidationError as error:
            if error.code == "UNMAPPED_REQUIREMENT":
                schema = _map_unmapped_requirements_to_global_constraints(
                    schema, error.details["ids"]
                )
                repair_used = True
                continue
            if validation_repairs >= MAX_SCHEMA_VALIDATION_REPAIRS:
                raise RubricCompilationError(
                    "validating_schema",
                    error.code,
                    "评分标准经多轮定向修复后仍未通过确定性校验",
                    error.details,
                ) from error
            validation_repairs += 1
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


def _map_unmapped_requirements_to_global_constraints(
    schema: RubricSchemaV2, requirement_ids: list[str]
) -> RubricSchemaV2:
    """Preserve unmapped source text without inventing scores or deleting requirements."""
    data = schema.model_dump()
    requirements_by_id = {
        item["id"]: item for item in data["source_requirements"]
    }
    used_ids = {
        item.id for item in schema.source_requirements
    } | {
        item.id for item in schema.global_constraints
    } | {
        dimension.id for dimension in schema.dimensions
    } | {
        item.id
        for dimension in schema.dimensions
        for item in [*dimension.criteria, *dimension.pitfalls]
    }
    if schema.scoring_policy is not None:
        used_ids.update(item.id for item in schema.scoring_policy.bonus_rules)
        used_ids.update(item.id for item in schema.scoring_policy.penalty_rules)

    for requirement_id in requirement_ids:
        requirement = requirements_by_id[requirement_id]
        constraint_id = f"GLO-AUTO-{requirement_id}"
        suffix = 2
        while constraint_id in used_ids:
            constraint_id = f"GLO-AUTO-{requirement_id}-{suffix}"
            suffix += 1
        used_ids.add(constraint_id)
        data["global_constraints"].append(
            {
                "id": constraint_id,
                "text": requirement["text"],
                "source_requirement_ids": [requirement_id],
            }
        )

    return RubricSchemaV2.model_validate(data)


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


def _normalize_affirmative_audit(
    audit: CoverageAuditResult,
) -> CoverageAuditResult:
    if (
        audit.passed
        or not audit.score_issues
        or audit.missing_requirement_ids
        or audit.unsupported_schema_paths
        or audit.conflicts
        or audit.repair_instructions
    ):
        return audit

    affirmative_markers = ("正确", "符合", "应视为忠实保存", "已完整记录")
    negative_markers = (
        "不正确",
        "未正确",
        "不符合",
        "无法",
        "遗漏",
        "缺失",
        "错误",
        "无依据",
        "语义弱化",
        "仍需",
    )
    conclusively_affirmative = all(
        "无需修复" in issue
        and any(marker in issue for marker in affirmative_markers)
        for issue in audit.score_issues
    )
    cautiously_affirmative = all(
        any(marker in issue for marker in affirmative_markers)
        and not any(marker in issue for marker in negative_markers)
        for issue in audit.score_issues
    )
    if conclusively_affirmative or cautiously_affirmative:
        return audit.model_copy(update={"passed": True, "score_issues": []})
    return audit


def _openai_timeout_seconds() -> int:
    raw_value = os.getenv("OPENAI_TIMEOUT_SECONDS")
    if not raw_value:
        return DEFAULT_OPENAI_TIMEOUT_SECONDS

    try:
        timeout = int(raw_value)
    except ValueError:
        return DEFAULT_OPENAI_TIMEOUT_SECONDS

    return timeout if timeout > 0 else DEFAULT_OPENAI_TIMEOUT_SECONDS
