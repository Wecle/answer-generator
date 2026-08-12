# Rubric Schema v2 and Prompt Pipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicated `compiledPrompt + rubric + rubricChecklist` generation input with an audited `RubricSchema v2` as the only scoring source and a conditional Prompt Pipe.

**Architecture:** FastAPI compiles one candidate Schema, validates it deterministically, audits it in an independent model call, and allows at most one targeted repair. PostgreSQL stores compilation state and Prompt/review metadata; Web refuses to queue unverified jobs; Worker sends only verified Schema, question context, length bounds, and structured retry feedback to generation and review services.

**Tech Stack:** Python 3.12, FastAPI, Pydantic, httpx, pytest, TypeScript 5.8, Next.js Route Handlers, BullMQ, Drizzle ORM, PostgreSQL 16, pnpm 10.13.1.

## Global Constraints

- `RubricSchema v2` is the only scoring-rule source used by new generation and review calls.
- Raw `rubric` remains persisted for compilation, audit, traceability, and recompilation, but must not enter a v2 generation Prompt.
- `compiledPrompt` remains in the database for compatibility but must not be read by the v2 generation path.
- Requirement extraction and candidate Schema compilation happen in one model call.
- Compilation and coverage audit use independent request contexts; they may use the same configured model.
- The pipeline allows at most one targeted Schema repair in total.
- Dimension scores must sum to exactly 100.
- Fully unscored Rubrics may use inferred weights and must set `inferred_scores: true`; partially scored or conflicting Rubrics must fail if one repair cannot resolve them unambiguously.
- A job cannot be queued unless its Schema is v2 and `compilation.coverage_passed` is true.
- Prompt sections load in this order: `base_role`, `rubric_constraints`, optional `material`, `question`, `length`, optional `multi_question`, optional `retry_feedback`, `output_rules`.
- Prompt pipeline version is `generation-pipe-v1`; Schema version is `rubric-schema-v2`.
- Existing v1 results remain readable and exportable; v1 jobs must be recompiled before any new generation.

---

## File Structure

### New files

- `apps/api/app/services/rubric_schema.py` — deterministic Schema v2 validation and audit-result types.
- `apps/api/app/services/prompt_pipe.py` — conditional Prompt Section selection and rendering.
- `apps/api/tests/__init__.py` — make shared API test fixtures importable without relying on namespace-package behavior.
- `apps/api/tests/rubric_fixtures.py` — complete reusable RubricSchema v2 fixture builders.
- `apps/api/tests/test_rubric_schema.py` — validator contract tests.
- `apps/api/tests/test_prompt_pipe.py` — Prompt inclusion, exclusion, ordering, and version tests.
- `apps/api/tests/test_reviewer.py` — criterion-level AI normalization and local fallback tests.
- `packages/shared/src/rubric-schema.ts` — TypeScript Schema v2 types and verified-Schema guard.
- `packages/shared/tests/rubric-schema.test.ts` — shared type guard tests.
- `apps/worker/src/ai-payloads.ts` — pure snake_case request builders and feedback conversion.
- `apps/worker/tests/fixtures.ts` — complete shared Worker Schema fixture.
- `apps/worker/tests/ai-payloads.test.ts` — Worker payload contract tests.
- `packages/db/migrations/0006_add_rubric_pipeline_metadata.sql` — generated Drizzle migration.

### Modified files

- `apps/api/app/models.py` — Schema v2, compilation, Prompt metadata, and criterion feedback models.
- `apps/api/app/services/rubric_compiler.py` — compile/validate/audit/repair pipeline.
- `apps/api/app/services/generator.py` — use Prompt Pipe and return Prompt metadata.
- `apps/api/app/services/reviewer.py` — score only against Schema v2 and return criterion feedback.
- `apps/api/app/services/orchestrator.py` — carry structured retry feedback.
- `apps/api/app/main.py` — return structured compilation failures.
- `apps/api/tests/test_rubric_compiler.py` — pipeline call-count and failure-stage tests.
- `apps/api/tests/test_generator.py` — reject missing/unverified Schema and verify metadata.
- `apps/api/tests/test_orchestrator.py` — structured feedback retry regression tests.
- `packages/shared/src/index.ts` — export Schema v2 contracts.
- `packages/db/src/schema.ts` — compilation, Prompt metadata, and criterion feedback columns.
- `apps/web/src/lib/rubric-compiler.ts` — consume v2 compile response and preserve structured errors.
- `apps/web/app/api/jobs/[id]/compile-rubric/route.ts` — persist compilation success/failure.
- `apps/web/app/api/jobs/[id]/run/route.ts` — verified-Schema queue gate.
- `apps/web/app/api/jobs/[id]/items/[itemId]/regenerate/route.ts` — same gate for single-item regeneration.
- `apps/worker/src/index.ts` — use payload builders and persist new metadata.
- `apps/worker/package.json` — add Worker unit-test script.
- `README.md` and `README.zh-CN.md` — document audited compilation and v1 recompilation behavior.

---

### Task 1: Define RubricSchema v2 and deterministic validation

**Files:**
- Create: `apps/api/app/services/rubric_schema.py`
- Create: `apps/api/tests/__init__.py`
- Create: `apps/api/tests/rubric_fixtures.py`
- Create: `apps/api/tests/test_rubric_schema.py`
- Modify: `apps/api/app/models.py`

**Interfaces:**
- Produces: `RubricSchemaV2`, `RubricCompilationMetadata`, `CoverageAuditResult`, and `validate_rubric_schema(schema: RubricSchemaV2) -> None`.
- Raises: `RubricSchemaValidationError(code: str, details: dict)` on deterministic failures.

- [ ] **Step 1: Write the failing validator tests**

```python
# apps/api/tests/rubric_fixtures.py
def valid_schema_data() -> dict:
    return {
        "version": "v2",
        "role_prompt": "你是一名结构化面试考生。",
        "source_requirements": [
            {"id": "REQ-001", "text": "准确分析问题", "kind": "criterion"},
            {"id": "REQ-002", "text": "措施形成闭环", "kind": "criterion"},
        ],
        "dimensions": [
            {
                "id": "DIM-001",
                "name": "综合分析",
                "max_score": 50,
                "source_requirement_ids": ["REQ-001"],
                "criteria": [{"id": "CRI-001", "text": "准确分析问题", "source_requirement_ids": ["REQ-001"]}],
                "pitfalls": [{"id": "PIT-001", "text": "只表态不分析", "source_requirement_ids": ["REQ-001"]}],
            },
            {
                "id": "DIM-002",
                "name": "解决问题",
                "max_score": 50,
                "source_requirement_ids": ["REQ-002"],
                "criteria": [{"id": "CRI-002", "text": "措施形成闭环", "source_requirement_ids": ["REQ-002"]}],
                "pitfalls": [{"id": "PIT-002", "text": "措施没有反馈", "source_requirement_ids": ["REQ-002"]}],
            },
        ],
        "answer_principles": ["围绕题目作答"],
        "retry_policy": ["定向修复低分项"],
        "output_rules": ["输出纯文本"],
        "compilation": {
            "compiler_model": "test-model",
            "auditor_model": None,
            "coverage_passed": False,
            "inferred_scores": False,
        },
    }


# apps/api/tests/test_rubric_schema.py
import pytest

from app.models import RubricSchemaV2
from app.services.rubric_schema import RubricSchemaValidationError, validate_rubric_schema
from tests.rubric_fixtures import valid_schema_data


def test_validator_accepts_complete_100_point_schema():
    validate_rubric_schema(RubricSchemaV2.model_validate(valid_schema_data()))


def test_validator_accepts_mapped_global_constraint():
    data = valid_schema_data()
    data["source_requirements"].append({"id": "REQ-003", "text": "结合基层实际", "kind": "global"})
    data["global_constraints"] = [{"id": "GLB-001", "text": "结合基层实际", "source_requirement_ids": ["REQ-003"]}]
    validate_rubric_schema(RubricSchemaV2.model_validate(data))


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (lambda data: data["dimensions"][1].update({"max_score": 40}), "INVALID_SCORE_TOTAL"),
        (lambda data: data["dimensions"][1].update({"id": "DIM-001"}), "DUPLICATE_ID"),
        (lambda data: data["dimensions"][0]["criteria"][0].update({"source_requirement_ids": ["REQ-999"]}), "UNKNOWN_REQUIREMENT"),
        (lambda data: data["source_requirements"].append({"id": "REQ-003", "text": "关注群众诉求", "kind": "criterion"}), "UNMAPPED_REQUIREMENT"),
    ],
)
def test_validator_rejects_invalid_schema(mutate, code):
    data = valid_schema_data()
    mutate(data)
    schema = RubricSchemaV2.model_validate(data)
    with pytest.raises(RubricSchemaValidationError) as error:
        validate_rubric_schema(schema)
    assert error.value.code == code
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `cd apps/api && python3 -m pytest tests/test_rubric_schema.py -v`

Expected: FAIL during import because `RubricSchemaV2` and `rubric_schema.py` do not exist.

- [ ] **Step 3: Add the Pydantic v2 contracts**

Replace the current scoring Schema classes in `apps/api/app/models.py` with these contracts and update request references from `RubricSchema` to `RubricSchemaV2`:

```python
class SourceRequirement(BaseModel):
    id: str
    text: str
    kind: Literal["dimension", "criterion", "pitfall", "score", "global"]


class RubricCriterionSchema(BaseModel):
    id: str
    text: str
    source_requirement_ids: List[str] = Field(min_length=1)


class RubricPitfallSchema(BaseModel):
    id: str
    text: str
    source_requirement_ids: List[str] = Field(min_length=1)


class RubricGlobalConstraint(BaseModel):
    id: str
    text: str
    source_requirement_ids: List[str] = Field(min_length=1)


class RubricDimensionSchemaV2(BaseModel):
    id: str
    name: str
    max_score: int = Field(gt=0)
    source_requirement_ids: List[str] = Field(min_length=1)
    criteria: List[RubricCriterionSchema] = Field(min_length=1)
    pitfalls: List[RubricPitfallSchema] = Field(min_length=1)


class RubricCompilationMetadata(BaseModel):
    compiler_model: str
    auditor_model: Optional[str] = None
    coverage_passed: bool = False
    inferred_scores: bool = False


class RubricSchemaV2(BaseModel):
    version: Literal["v2"] = "v2"
    role_prompt: str
    source_requirements: List[SourceRequirement] = Field(min_length=1)
    global_constraints: List[RubricGlobalConstraint] = Field(default_factory=list)
    dimensions: List[RubricDimensionSchemaV2] = Field(min_length=1)
    answer_principles: List[str] = Field(default_factory=list)
    retry_policy: List[str] = Field(default_factory=list)
    output_rules: List[str] = Field(default_factory=list)
    compilation: RubricCompilationMetadata


class CoverageConflict(BaseModel):
    requirement_id: str
    schema_path: str
    reason: str


class CoverageAuditResult(BaseModel):
    passed: bool
    missing_requirement_ids: List[str] = Field(default_factory=list)
    unsupported_schema_paths: List[str] = Field(default_factory=list)
    conflicts: List[CoverageConflict] = Field(default_factory=list)
    score_issues: List[str] = Field(default_factory=list)
    repair_instructions: List[str] = Field(default_factory=list)
```

- [ ] **Step 4: Implement deterministic validation**

```python
# apps/api/app/services/rubric_schema.py
from app.models import RubricSchemaV2


class RubricSchemaValidationError(ValueError):
    def __init__(self, code: str, details: dict):
        super().__init__(code)
        self.code = code
        self.details = details


def validate_rubric_schema(schema: RubricSchemaV2) -> None:
    ids = [requirement.id for requirement in schema.source_requirements]
    ids += [constraint.id for constraint in schema.global_constraints]
    ids += [dimension.id for dimension in schema.dimensions]
    ids += [criterion.id for dimension in schema.dimensions for criterion in dimension.criteria]
    ids += [pitfall.id for dimension in schema.dimensions for pitfall in dimension.pitfalls]
    duplicates = sorted({value for value in ids if ids.count(value) > 1})
    if duplicates:
        raise RubricSchemaValidationError("DUPLICATE_ID", {"ids": duplicates})

    names = [dimension.name.strip() for dimension in schema.dimensions]
    if len(set(names)) != len(names):
        raise RubricSchemaValidationError("DUPLICATE_DIMENSION", {"names": names})

    total = sum(dimension.max_score for dimension in schema.dimensions)
    if total != 100:
        raise RubricSchemaValidationError("INVALID_SCORE_TOTAL", {"total": total})

    requirement_ids = {requirement.id for requirement in schema.source_requirements}
    mapped_ids: set[str] = set()
    for constraint in schema.global_constraints:
        unknown = sorted(set(constraint.source_requirement_ids) - requirement_ids)
        if unknown:
            raise RubricSchemaValidationError("UNKNOWN_REQUIREMENT", {"ids": unknown})
        mapped_ids.update(constraint.source_requirement_ids)
    for dimension in schema.dimensions:
        references = list(dimension.source_requirement_ids)
        references += [item for criterion in dimension.criteria for item in criterion.source_requirement_ids]
        references += [item for pitfall in dimension.pitfalls for item in pitfall.source_requirement_ids]
        unknown = sorted(set(references) - requirement_ids)
        if unknown:
            raise RubricSchemaValidationError("UNKNOWN_REQUIREMENT", {"ids": unknown})
        mapped_ids.update(references)

    unmapped = sorted(requirement_ids - mapped_ids)
    if unmapped:
        raise RubricSchemaValidationError("UNMAPPED_REQUIREMENT", {"ids": unmapped})
```

- [ ] **Step 5: Run tests and commit**

Run: `cd apps/api && python3 -m pytest tests/test_rubric_schema.py -v`

Expected: all tests PASS.

```bash
git add apps/api/app/models.py apps/api/app/services/rubric_schema.py apps/api/tests/__init__.py apps/api/tests/rubric_fixtures.py apps/api/tests/test_rubric_schema.py
git commit -m "feat(api): add rubric schema v2 validation"
```

---

### Task 2: Implement compile, independent audit, and one-repair pipeline

**Files:**
- Modify: `apps/api/app/services/rubric_compiler.py`
- Modify: `apps/api/app/main.py`
- Modify: `apps/api/tests/test_rubric_compiler.py`

**Interfaces:**
- Consumes: `RubricSchemaV2`, `CoverageAuditResult`, `validate_rubric_schema` from Task 1.
- Produces: `compile_rubric(request) -> CompileRubricResponse` with verified Schema and `RubricCompilationError(stage, code, message, details)` for structured failures.

- [ ] **Step 1: Replace old compiler tests with pipeline contract tests**

Add fake-completion tests that feed exact responses in order:

```python
import json
from app.models import CompileRubricRequest
from app.services.rubric_compiler import RubricCompilationError, _compile_with_openai
import app.services.rubric_compiler as rubric_compiler
from tests.rubric_fixtures import valid_schema_data


def make_request() -> CompileRubricRequest:
    return CompileRubricRequest(rubric="综合分析50分，解决问题50分。", answer_minutes=2, passing_score=95)


def install_fake_completions(monkeypatch, responses: list[str]) -> list[str]:
    calls: list[str] = []

    class FakeResponse:
        def __init__(self, content: str):
            self.content = content

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": self.content}}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            self.responses = [FakeResponse(content) for content in responses]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            calls.append(json["messages"][1]["content"])
            return self.responses.pop(0)

    monkeypatch.setattr(rubric_compiler.httpx, "AsyncClient", FakeAsyncClient)
    return calls


def failing_sequence_after_repair() -> list[str]:
    schema = valid_schema_data()
    failed_audit = {
        "passed": False,
        "missing_requirement_ids": ["REQ-002"],
        "unsupported_schema_paths": [],
        "conflicts": [],
        "score_issues": [],
        "repair_instructions": ["补充 REQ-002 映射"],
    }
    return [
        json.dumps(schema, ensure_ascii=False),
        json.dumps(failed_audit, ensure_ascii=False),
        json.dumps(schema, ensure_ascii=False),
        json.dumps(failed_audit, ensure_ascii=False),
    ]


@pytest.mark.asyncio
async def test_compile_pipeline_compiles_and_audits_without_repair(monkeypatch):
    responses = [json.dumps(valid_schema_data(), ensure_ascii=False), json.dumps({
        "passed": True,
        "missing_requirement_ids": [],
        "unsupported_schema_paths": [],
        "conflicts": [],
        "score_issues": [],
        "repair_instructions": [],
    }, ensure_ascii=False)]
    calls = install_fake_completions(monkeypatch, responses)

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.version == "v2"
    assert result.rubric_schema.compilation.coverage_passed is True
    assert len(calls) == 2
    assert "独立审计" in calls[1]


@pytest.mark.asyncio
async def test_compile_pipeline_repairs_once_after_failed_audit(monkeypatch):
    first = valid_schema_data()
    first["source_requirements"].append({"id": "REQ-003", "text": "关注群众诉求", "kind": "criterion"})
    first["dimensions"][1]["source_requirement_ids"].append("REQ-003")
    audit_failed = {
        "passed": False,
        "missing_requirement_ids": ["REQ-003"],
        "unsupported_schema_paths": [],
        "conflicts": [],
        "score_issues": [],
        "repair_instructions": ["新增群众诉求 criterion 并映射 REQ-003"],
    }
    repaired = valid_schema_data()
    repaired["source_requirements"].append({"id": "REQ-003", "text": "关注群众诉求", "kind": "criterion"})
    repaired["dimensions"][1]["criteria"].append({"id": "CRI-003", "text": "关注群众诉求", "source_requirement_ids": ["REQ-003"]})
    repaired["dimensions"][1]["source_requirement_ids"].append("REQ-003")
    audit_passed = {**audit_failed, "passed": True, "missing_requirement_ids": [], "repair_instructions": []}
    calls = install_fake_completions(monkeypatch, [
        json.dumps(first, ensure_ascii=False),
        json.dumps(audit_failed, ensure_ascii=False),
        json.dumps(repaired, ensure_ascii=False),
        json.dumps(audit_passed, ensure_ascii=False),
    ])

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.compilation.coverage_passed is True
    assert len(calls) == 4


@pytest.mark.asyncio
async def test_compile_pipeline_fails_after_single_repair(monkeypatch):
    calls = install_fake_completions(monkeypatch, failing_sequence_after_repair())
    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")
    assert error.value.stage == "auditing_repaired_schema"
    assert error.value.code == "COVERAGE_AUDIT_FAILED"
    assert len(calls) == 4
```

- [ ] **Step 2: Run compiler tests and confirm they fail**

Run: `cd apps/api && python3 -m pytest tests/test_rubric_compiler.py -v`

Expected: FAIL because the compiler still returns v1 Schema and has no audit stage.

- [ ] **Step 3: Implement structured compilation errors and response**

Update `CompileRubricResponse` in `models.py` to remove `compiled_prompt` and use `RubricSchemaV2`:

```python
class CompileRubricResponse(BaseModel):
    rubric_schema: RubricSchemaV2
    compiler_model: str
    auditor_model: str


class RubricCompilationError(RuntimeError):
    def __init__(self, stage: str, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.stage = stage
        self.code = code
        self.message = message
        self.details = details or {}

    def as_dict(self) -> dict:
        return {"stage": self.stage, "code": self.code, "message": self.message, "details": self.details}
```

Catch this error before the generic error handlers in `main.py`:

```python
except RubricCompilationError as error:
    raise HTTPException(status_code=422, detail=error.as_dict()) from error
```

- [ ] **Step 4: Implement the finite pipeline**

Refactor `rubric_compiler.py` around these exact helpers:

```python
async def _compile_candidate(client, base_url, model, api_key, request) -> RubricSchemaV2:
    data = await _post_json_completion(
        client, base_url, model, api_key,
        _build_compile_prompt(request),
        "你是公务员面试评分标准编译器。",
    )
    return RubricSchemaV2.model_validate(data)


async def _audit_candidate(client, base_url, model, api_key, request, schema) -> CoverageAuditResult:
    data = await _post_json_completion(
        client, base_url, model, api_key,
        _build_audit_prompt(request, schema),
        "你是独立的评分标准覆盖审计员，只以用户原始评分标准为依据。",
    )
    return CoverageAuditResult.model_validate(data)


async def _repair_candidate(client, base_url, model, api_key, request, schema, errors) -> RubricSchemaV2:
    data = await _post_json_completion(
        client, base_url, model, api_key,
        _build_repair_prompt(request, schema, errors),
        "你是评分标准 Schema 定向修复器，只修复报告指出的问题。",
    )
    return RubricSchemaV2.model_validate(data)


async def _post_json_completion(client, base_url, model, api_key, prompt, system_prompt) -> dict:
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
    return json.loads(response.json()["choices"][0]["message"]["content"])


def _build_audit_prompt(request, schema) -> str:
    return (
        "请独立审计候选 Schema 是否完整、忠实地覆盖原始评分标准。只输出 CoverageAuditResult JSON。\n"
        "不得沿用编译器结论；逐项检查遗漏、无原文依据的新增内容、语义弱化和分值问题。"
        "原文完全无分值时才允许 inferred_scores=true；原文部分有分值、分值冲突或明确分值总和不正确时必须写入 score_issues。\n\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"候选 Schema：\n{schema.model_dump_json()}"
    )


def _build_repair_prompt(request, schema, errors) -> str:
    return (
        "只修复校验或审计报告指出的问题，保留其余已验证内容。输出完整 RubricSchema v2 JSON。\n\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"候选 Schema：\n{schema.model_dump_json()}\n\n"
        f"修复报告：\n{json.dumps(errors, ensure_ascii=False)}"
    )


async def _compile_with_openai(request, api_key):
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    async with httpx.AsyncClient(timeout=_openai_timeout_seconds()) as client:
        schema = await _compile_candidate(client, base_url, model, api_key, request)
        repair_used = False
        try:
            validate_rubric_schema(schema)
        except RubricSchemaValidationError as error:
            schema = await _repair_candidate(client, base_url, model, api_key, request, schema, {
                "code": error.code, "details": error.details
            })
            repair_used = True
            validate_rubric_schema(schema)

        audit = await _audit_candidate(client, base_url, model, api_key, request, schema)
        if not audit.passed:
            if repair_used:
                raise RubricCompilationError("auditing_repaired_schema", "COVERAGE_AUDIT_FAILED", "评分标准覆盖审计失败", audit.model_dump())
            schema = await _repair_candidate(client, base_url, model, api_key, request, schema, audit.model_dump())
            repair_used = True
            validate_rubric_schema(schema)
            audit = await _audit_candidate(client, base_url, model, api_key, request, schema)
            if not audit.passed:
                raise RubricCompilationError("auditing_repaired_schema", "COVERAGE_AUDIT_FAILED", "评分标准覆盖审计失败", audit.model_dump())

    schema.compilation.auditor_model = model
    schema.compilation.coverage_passed = True
    return CompileRubricResponse(rubric_schema=schema, compiler_model=model, auditor_model=model)
```

Wrap JSON parsing, HTTP failures, and post-repair validation failures into `RubricCompilationError` with the current stage. The compile Prompt must demand `source_requirements` and complete v2 JSON in one response. The audit Prompt must explicitly state that it is independent, must treat raw Rubric as authoritative, and may only return `CoverageAuditResult` JSON.

- [ ] **Step 5: Run compiler and API tests**

Run: `cd apps/api && python3 -m pytest tests/test_rubric_schema.py tests/test_rubric_compiler.py tests/test_main.py -v`

Expected: all tests PASS, including exact call counts of 2 without repair and 4 after an audit repair.

- [ ] **Step 6: Commit**

```bash
git add apps/api/app/models.py apps/api/app/main.py apps/api/app/services/rubric_compiler.py apps/api/tests/test_rubric_compiler.py
git commit -m "feat(api): audit rubric schema compilation"
```

---

### Task 3: Add shared TypeScript contracts and persistence columns

**Files:**
- Create: `packages/shared/src/rubric-schema.ts`
- Create: `packages/shared/tests/rubric-schema.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0006_add_rubric_pipeline_metadata.sql`
- Modify: `packages/db/migrations/meta/_journal.json`
- Create: `packages/db/migrations/meta/0006_snapshot.json`

**Interfaces:**
- Produces: `RubricSchemaV2`, `RubricCompilationState`, `PromptMetadata`, `FailedCriterion`, `isVerifiedRubricSchemaV2(value): value is RubricSchemaV2`.
- Database fields: Job `rubricCompilation`; Attempt `promptMetadata`; Review `failedCriteria` and `preservedCriteriaIds`.

- [ ] **Step 1: Write shared guard tests**

```typescript
// packages/shared/tests/rubric-schema.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { isVerifiedRubricSchemaV2 } from "../src/rubric-schema";

test("accepts an audited v2 schema", () => {
  assert.equal(isVerifiedRubricSchemaV2({
    version: "v2",
    rolePrompt: "考生",
    sourceRequirements: [{ id: "REQ-001", text: "准确审题", kind: "criterion" }],
    globalConstraints: [],
    dimensions: [{
      id: "DIM-001", name: "审题", maxScore: 100, sourceRequirementIds: ["REQ-001"],
      criteria: [{ id: "CRI-001", text: "准确审题", sourceRequirementIds: ["REQ-001"] }],
      pitfalls: [{ id: "PIT-001", text: "偏题", sourceRequirementIds: ["REQ-001"] }]
    }],
    answerPrinciples: [], retryPolicy: [], outputRules: [],
    compilation: { compilerModel: "test", auditorModel: "test", coveragePassed: true, inferredScores: false }
  }), true);
});

test("rejects v1 and unaudited schemas", () => {
  assert.equal(isVerifiedRubricSchemaV2({ rolePrompt: "legacy", dimensions: [] }), false);
  assert.equal(isVerifiedRubricSchemaV2({ version: "v2", compilation: { coveragePassed: false } }), false);
});
```

- [ ] **Step 2: Run the shared test and confirm failure**

Run: `pnpm --filter @answer-generator/shared test`

Expected: FAIL because `src/rubric-schema.ts` does not exist.

- [ ] **Step 3: Implement shared contracts and guard**

```typescript
// packages/shared/src/rubric-schema.ts
export type SourceRequirementKind = "dimension" | "criterion" | "pitfall" | "score" | "global";
export interface SourceRequirement { id: string; text: string; kind: SourceRequirementKind }
export interface RubricCriterion { id: string; text: string; sourceRequirementIds: string[] }
export interface RubricPitfall { id: string; text: string; sourceRequirementIds: string[] }
export interface RubricGlobalConstraint { id: string; text: string; sourceRequirementIds: string[] }
export interface RubricDimensionV2 {
  id: string; name: string; maxScore: number; sourceRequirementIds: string[];
  criteria: RubricCriterion[]; pitfalls: RubricPitfall[];
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
  compilation: { compilerModel: string; auditorModel: string | null; coveragePassed: boolean; inferredScores: boolean };
}
export interface RubricCompilationState {
  stage: string; code?: string; message?: string; details?: Record<string, unknown>; compilerModel?: string; auditorModel?: string; updatedAt: string;
}
export interface PromptMetadata {
  pipelineVersion: "generation-pipe-v1"; schemaVersion: "rubric-schema-v2";
  basePromptVersion: "base-v1"; rubricPromptVersion: "rubric-v1"; retryPromptVersion: "retry-v1";
  loadedSections: string[];
}
export interface FailedCriterion { criterionId: string; reason: string; repairInstruction: string }
export interface PersistedReviewDimension { dimensionId: string; name: string; score: number; maxScore: number }

export function isVerifiedRubricSchemaV2(value: unknown): value is RubricSchemaV2 {
  if (!value || typeof value !== "object") return false;
  const schema = value as Partial<RubricSchemaV2>;
  return schema.version === "v2" && schema.compilation?.coveragePassed === true &&
    Array.isArray(schema.sourceRequirements) && schema.sourceRequirements.length > 0 &&
    Array.isArray(schema.dimensions) && schema.dimensions.length > 0;
}
```

Export it from `packages/shared/src/index.ts` with `export * from "./rubric-schema";`.

- [ ] **Step 4: Add Drizzle fields using the shared types**

Change `packages/db/src/schema.ts`:

```typescript
import type { FailedCriterion, PersistedReviewDimension, PromptMetadata, RubricCompilationState, RubricSchemaV2 } from "@answer-generator/shared";

// answerGenerationJobs
rubricSchema: jsonb("rubric_schema").$type<RubricSchemaV2>(),
rubricCompilation: jsonb("rubric_compilation").$type<RubricCompilationState>(),

// answerGenerationAttempts
promptMetadata: jsonb("prompt_metadata").$type<PromptMetadata>(),

// answerGenerationReviews
dimensions: jsonb("dimensions").notNull().$type<PersistedReviewDimension[]>(),
failedCriteria: jsonb("failed_criteria").notNull().default([]).$type<FailedCriterion[]>(),
preservedCriteriaIds: jsonb("preserved_criteria_ids").notNull().default([]).$type<string[]>(),
```

- [ ] **Step 5: Generate and inspect the migration**

Run: `pnpm --filter @answer-generator/db db:generate -- --name add_rubric_pipeline_metadata`

Expected: creates `0006_add_rubric_pipeline_metadata.sql` and matching Drizzle metadata.

Run: `sed -n '1,200p' packages/db/migrations/0006_add_rubric_pipeline_metadata.sql`

Expected SQL includes:

```sql
ALTER TABLE "answer_generation_jobs" ADD COLUMN "rubric_compilation" jsonb;
ALTER TABLE "answer_generation_attempts" ADD COLUMN "prompt_metadata" jsonb;
ALTER TABLE "answer_generation_reviews" ADD COLUMN "failed_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "answer_generation_reviews" ADD COLUMN "preserved_criteria_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
```

- [ ] **Step 6: Run shared tests and typecheck**

Run: `pnpm --filter @answer-generator/shared test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): persist rubric pipeline metadata"
```

---

### Task 4: Persist compilation state and gate job execution

**Files:**
- Modify: `apps/web/src/lib/rubric-compiler.ts`
- Modify: `apps/web/app/api/jobs/[id]/compile-rubric/route.ts`
- Modify: `apps/web/app/api/jobs/[id]/run/route.ts`
- Modify: `apps/web/app/api/jobs/[id]/items/[itemId]/regenerate/route.ts`
- Modify: `apps/web/app/api/jobs/route.ts`
- Modify: `apps/web/app/api/jobs/[id]/route.ts`

**Interfaces:**
- Consumes: `RubricSchemaV2`, `RubricCompilationState`, `isVerifiedRubricSchemaV2` from Task 3.
- Produces: persisted compilation status and HTTP 409 gate for invalid, v1, or unaudited Schema.

- [ ] **Step 1: Add a typed compile response mapper**

Update `apps/web/src/lib/rubric-compiler.ts` so the API payload maps snake_case into the Task 3 interfaces. The public result is:

```typescript
export interface CompiledRubricResult {
  rubricSchema: RubricSchemaV2;
  compilation: RubricCompilationState;
}

export class RubricCompilationRequestError extends Error {
  constructor(public readonly compilation: RubricCompilationState) {
    super(compilation.message ?? "评分标准分析失败");
  }
}
```

For non-2xx responses, parse FastAPI `{ detail: { stage, code, message, details } }`; fall back to `stage: "failed"`, `code: "AI_SERVICE_ERROR"`, and the response text. For success, set `stage: "completed"`, copy compiler/auditor model names, and set `updatedAt` to `new Date().toISOString()`.

- [ ] **Step 2: Persist compilation lifecycle in the route**

Before calling FastAPI, set:

```typescript
rubricCompilation: { stage: "compiling_schema", updatedAt: new Date().toISOString() }
```

On success, persist `rubricSchema`, set `compiledPrompt: null`, store returned compilation metadata, and change `compiling_rubric` to `draft`.

On `RubricCompilationRequestError`, persist its `compilation`, set Job to `failed`, and return the same structured detail with HTTP 422. Other failures use `AI_SERVICE_ERROR` and HTTP 502.

- [ ] **Step 3: Clear old compilation state on create and update**

In create/update Job routes, persist:

```typescript
compiledPrompt: null,
rubricSchema: null,
rubricCompilation: { stage: "extracting_requirements", updatedAt: new Date().toISOString() },
status: RUBRIC_COMPILING_STATUS
```

- [ ] **Step 4: Add the verified-Schema gate to both queue routes**

Immediately after loading the Job in full-run and item-regeneration routes:

```typescript
if (!isVerifiedRubricSchemaV2(currentJob.rubricSchema)) {
  return Response.json(
    { error: "评分标准尚未通过完整性审计，请重新分析评分标准" },
    { status: 409 }
  );
}
```

The guard must run before resetting attempts or changing any statuses.

- [ ] **Step 5: Run typecheck and manually verify route ordering**

Run: `pnpm typecheck`

Expected: PASS.

Run: `rg -n "isVerifiedRubricSchemaV2|resetJobResults|resetJobItemResult" apps/web/app/api/jobs`

Expected: each queue route checks `isVerifiedRubricSchemaV2` before calling a reset helper.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/rubric-compiler.ts apps/web/app/api/jobs
git commit -m "feat(web): gate generation on audited rubric"
```

---

### Task 5: Build the conditional Prompt Pipe and remove duplicate scoring inputs

**Files:**
- Create: `apps/api/app/services/prompt_pipe.py`
- Create: `apps/api/tests/test_prompt_pipe.py`
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/app/services/generator.py`
- Modify: `apps/api/tests/test_generator.py`

**Interfaces:**
- Consumes: verified `RubricSchemaV2`, question context, three word bounds, and optional `RetryFeedback`.
- Produces: `build_generation_prompt(request) -> PromptBuildResult` and `GenerateAnswerResponse.prompt_metadata`.

- [ ] **Step 1: Add failing Prompt Pipe tests**

```python
# apps/api/tests/test_prompt_pipe.py
from app.models import GenerateAnswerRequest, RetryFeedback
from app.services.prompt_pipe import build_generation_prompt
from tests.rubric_fixtures import valid_schema_data


def make_request(**overrides):
    values = {
        "question": "请谈谈如何提升基层治理能力？",
        "rubric_schema": valid_schema_data(),
        "answer_minutes": 2,
        "target_min_words": 420,
        "target_words": 520,
        "target_max_words": 620,
    }
    values.update(overrides)
    return GenerateAnswerRequest(**values)


def test_prompt_uses_schema_once_and_excludes_legacy_sources():
    result = build_generation_prompt(make_request())
    assert result.prompt.count("准确分析问题") == 1
    assert "原始评分标准" not in result.prompt
    assert "任务核心提示词" not in result.prompt
    assert result.metadata.loaded_sections == [
        "base_role", "rubric_constraints", "question", "length", "output_rules"
    ]


def test_prompt_loads_only_present_optional_sections():
    result = build_generation_prompt(make_request(
        material="某地正在推进基层治理改革。",
        question="问题 1：分析原因。\n问题 2：提出措施。",
        previous_feedback=RetryFeedback(
            failed_criteria=[{"criterion_id": "CRI-001", "reason": "原因单一", "repair_instruction": "补充制度原因"}],
            preserved_criteria_ids=["CRI-002"],
        ),
    ))
    assert "material" in result.metadata.loaded_sections
    assert "multi_question" in result.metadata.loaded_sections
    assert "retry_feedback" in result.metadata.loaded_sections
    assert "补充制度原因" in result.prompt
    assert "420～620" in result.prompt
```

- [ ] **Step 2: Run Prompt tests and confirm failure**

Run: `cd apps/api && python3 -m pytest tests/test_prompt_pipe.py -v`

Expected: FAIL because Prompt Pipe and new request models do not exist.

- [ ] **Step 3: Replace generation request/response contracts**

```python
class FailedCriterion(BaseModel):
    criterion_id: str
    reason: str
    repair_instruction: str


class RetryFeedback(BaseModel):
    failed_criteria: List[FailedCriterion] = Field(default_factory=list)
    preserved_criteria_ids: List[str] = Field(default_factory=list)
    reasons: List[str] = Field(default_factory=list)


class PromptMetadata(BaseModel):
    pipeline_version: Literal["generation-pipe-v1"] = "generation-pipe-v1"
    schema_version: Literal["rubric-schema-v2"] = "rubric-schema-v2"
    base_prompt_version: Literal["base-v1"] = "base-v1"
    rubric_prompt_version: Literal["rubric-v1"] = "rubric-v1"
    retry_prompt_version: Literal["retry-v1"] = "retry-v1"
    loaded_sections: List[str]


class GenerateAnswerRequest(BaseModel):
    material: Optional[str] = None
    question: str
    rubric_schema: RubricSchemaV2
    answer_minutes: float = Field(gt=0)
    target_min_words: int = Field(gt=0)
    target_words: int = Field(gt=0)
    target_max_words: int = Field(gt=0)
    previous_feedback: Optional[RetryFeedback] = None


class GenerateAnswerResponse(BaseModel):
    answer: str
    model: str
    prompt_version: str = "generation-pipe-v1+rubric-schema-v2"
    prompt_metadata: PromptMetadata
```

Use a Pydantic model validator on `GenerateAnswerRequest` to reject Schema with `coverage_passed != true` and word bounds that do not satisfy `min <= target <= max`.

- [ ] **Step 4: Implement Prompt Pipe**

```python
# apps/api/app/services/prompt_pipe.py
import re
from pydantic import BaseModel
from app.models import GenerateAnswerRequest, PromptMetadata


class PromptBuildResult(BaseModel):
    prompt: str
    metadata: PromptMetadata


def _is_multi_question(question: str) -> bool:
    return len(re.findall(r"(?:^|\n)\s*(?:问题|第)\s*\d+", question)) >= 2


def build_generation_prompt(request: GenerateAnswerRequest) -> PromptBuildResult:
    sections: list[tuple[str, str]] = []
    sections.append(("base_role", request.rubric_schema.role_prompt + "\n请在内部判断核心作答任务并选择合适结构，不要输出判断过程。"))
    dimension_blocks = []
    if request.rubric_schema.global_constraints:
        dimension_blocks.append("全局要求\n" + "\n".join(f"- [{item.id}] {item.text}" for item in request.rubric_schema.global_constraints))
    for dimension in request.rubric_schema.dimensions:
        lines = [f"{dimension.name}（{dimension.max_score} 分）"]
        lines.extend(f"- [{criterion.id}] {criterion.text}" for criterion in dimension.criteria)
        lines.extend(f"- 避免：{pitfall.text}" for pitfall in dimension.pitfalls)
        dimension_blocks.append("\n".join(lines))
    sections.append(("rubric_constraints", "本题必须满足以下评分约束：\n" + "\n\n".join(dimension_blocks)))
    if request.material and request.material.strip():
        sections.append(("material", "材料：\n" + request.material.strip()))
    sections.append(("question", "题目：\n" + request.question.strip()))
    sections.append(("length", f"篇幅要求：适合 {request.answer_minutes} 分钟口述，目标 {request.target_words} 字，允许范围 {request.target_min_words}～{request.target_max_words} 字。"))
    if _is_multi_question(request.question):
        sections.append(("multi_question", "题目包含多个问题，请逐问完整回答，并使用“第 1 题”“第 2 题”分段。"))
    if request.previous_feedback and request.previous_feedback.failed_criteria:
        retry_lines = ["本轮是定向修复，请修复低分项并保留已满足内容："]
        retry_lines.extend(f"- [{item.criterion_id}] {item.repair_instruction}（{item.reason}）" for item in request.previous_feedback.failed_criteria)
        if request.previous_feedback.preserved_criteria_ids:
            retry_lines.append("应保留：" + "、".join(request.previous_feedback.preserved_criteria_ids))
        sections.append(("retry_feedback", "\n".join(retry_lines)))
    sections.append(("output_rules", "输出适合现场口述的纯文本；不得出现评分、审核、criterion ID、Markdown、批注或舞台提示。"))
    return PromptBuildResult(
        prompt="\n\n".join(content for _, content in sections),
        metadata=PromptMetadata(loaded_sections=[name for name, _ in sections]),
    )
```

- [ ] **Step 5: Switch generator to the pipe**

In `generator.py`, delete `_rubric_focus_points`, `_focus_points`, `_extract_keywords`, and the legacy `_build_prompt`. Call `build_generation_prompt`, send `result.prompt`, and return the same `result.metadata` in `GenerateAnswerResponse`. Keep `_strip_markdown` and existing model parameters.

- [ ] **Step 6: Run Prompt and generator tests**

Run: `cd apps/api && python3 -m pytest tests/test_prompt_pipe.py tests/test_generator.py -v`

Expected: PASS; tests assert raw Rubric and compiled Prompt labels never appear.

- [ ] **Step 7: Commit**

```bash
git add apps/api/app/models.py apps/api/app/services/prompt_pipe.py apps/api/app/services/generator.py apps/api/tests/test_prompt_pipe.py apps/api/tests/test_generator.py
git commit -m "feat(api): compose generation prompts conditionally"
```

---

### Task 6: Make review criterion-aware and Schema-only

**Files:**
- Create: `apps/api/tests/test_reviewer.py`
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/app/services/reviewer.py`

**Interfaces:**
- Consumes: `ReviewAnswerRequest` with verified Schema v2 and no raw Rubric.
- Produces: dimension IDs, `failed_criteria`, `preserved_criteria_ids`, recomputed total, and natural-language reasons.

- [ ] **Step 1: Write AI-normalization and fallback tests**

```python
# apps/api/tests/test_reviewer.py
import pytest
import json
from app.models import ReviewAnswerRequest
from app.services.reviewer import review_answer
import app.services.reviewer as reviewer
from tests.rubric_fixtures import valid_schema_data


def make_review_request() -> ReviewAnswerRequest:
    return ReviewAnswerRequest(
        question="如何形成工作闭环？",
        rubric_schema=valid_schema_data(),
        answer="要准确分析问题并提出措施。",
        passing_score=95,
    )


def install_review_completion(monkeypatch, payload: dict) -> None:
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            return FakeResponse()

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(reviewer.httpx, "AsyncClient", FakeAsyncClient)


@pytest.mark.asyncio
async def test_local_reviewer_returns_criterion_feedback(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = await review_answer(ReviewAnswerRequest(
        question="如何形成工作闭环？",
        rubric_schema=valid_schema_data(),
        answer="要准确分析问题。",
        passing_score=95,
    ))
    assert result.total_score == sum(item.score for item in result.dimensions)
    assert any(item.criterion_id == "CRI-002" for item in result.failed_criteria)
    assert "CRI-001" in result.preserved_criteria_ids


@pytest.mark.asyncio
async def test_reviewer_rejects_model_total_and_unknown_criteria(monkeypatch):
    install_review_completion(monkeypatch, {
        "dimensions": [{"dimension_id": "DIM-001", "score": 45}, {"dimension_id": "DIM-002", "score": 35}],
        "failed_criteria": [
            {"criterion_id": "CRI-002", "reason": "缺少闭环", "repair_instruction": "补充反馈整改"},
            {"criterion_id": "CRI-999", "reason": "未知", "repair_instruction": "忽略"},
        ],
        "preserved_criteria_ids": ["CRI-001", "CRI-999"],
        "total_score": 100,
        "passed": True,
        "reasons": ["需要形成闭环"],
    })
    result = await review_answer(make_review_request())
    assert result.total_score == 80
    assert result.passed is False
    assert [item.criterion_id for item in result.failed_criteria] == ["CRI-002"]
    assert result.preserved_criteria_ids == ["CRI-001"]
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd apps/api && python3 -m pytest tests/test_reviewer.py -v`

Expected: FAIL because review models have no criterion-level fields.

- [ ] **Step 3: Replace review contracts**

```python
class ReviewAnswerRequest(BaseModel):
    material: Optional[str] = None
    question: str
    rubric_schema: RubricSchemaV2
    answer: str
    passing_score: int = Field(default=95, ge=0, le=100)


class ReviewDimension(BaseModel):
    dimension_id: str
    name: str
    score: int
    max_score: int


class ReviewAnswerResponse(BaseModel):
    total_score: int
    passed: bool
    dimensions: List[ReviewDimension]
    failed_criteria: List[FailedCriterion] = Field(default_factory=list)
    preserved_criteria_ids: List[str] = Field(default_factory=list)
    reasons: List[str]
    reviewer_model: str
```

- [ ] **Step 4: Refactor reviewer to Schema-only scoring**

Delete raw-Rubric parsing from the active v2 path. Build the AI review Prompt exclusively from Schema dimension IDs, criterion IDs/text, and pitfall text. Normalize model output against known IDs:

```python
known_dimensions = {item.id: item for item in request.rubric_schema.dimensions}
known_criteria = {item.id: item for dimension in request.rubric_schema.dimensions for item in dimension.criteria}
dimensions = [
    ReviewDimension(
        dimension_id=dimension.id,
        name=dimension.name,
        score=max(0, min(dimension.max_score, ai_scores.get(dimension.id, 0))),
        max_score=dimension.max_score,
    )
    for dimension in request.rubric_schema.dimensions
]
total_score = min(100, sum(item.score for item in dimensions))
passed = total_score >= request.passing_score
failed_criteria = [item for item in normalized_failed if item.criterion_id in known_criteria]
preserved = [item for item in normalized_preserved if item in known_criteria]
```

Keep the local fallback, but compute keyword coverage from Schema criterion text. A criterion with a hit goes into `preserved_criteria_ids`; a miss creates `FailedCriterion` with a concrete repair instruction derived from its text. Do not fall back to parsing raw Rubric.

- [ ] **Step 5: Run reviewer tests**

Run: `cd apps/api && python3 -m pytest tests/test_reviewer.py -v`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/app/models.py apps/api/app/services/reviewer.py apps/api/tests/test_reviewer.py
git commit -m "feat(api): return criterion-level review feedback"
```

---

### Task 7: Carry Prompt metadata and structured feedback through orchestrator and Worker

**Files:**
- Create: `apps/worker/src/ai-payloads.ts`
- Create: `apps/worker/tests/fixtures.ts`
- Create: `apps/worker/tests/ai-payloads.test.ts`
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/api/app/services/orchestrator.py`
- Modify: `apps/api/tests/test_orchestrator.py`

**Interfaces:**
- Consumes: Task 3 shared types and Task 5/6 API contracts.
- Produces: exact snake_case API payloads; persisted Attempt Prompt metadata and Review criterion feedback; structured feedback on each retry.

- [ ] **Step 1: Write Worker payload tests**

```typescript
// apps/worker/tests/ai-payloads.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildGeneratePayload, buildReviewPayload, toRetryFeedback } from "../src/ai-payloads";
import { verifiedSchemaFixture } from "./fixtures";

test("generation payload excludes raw rubric and compiled prompt", () => {
  const payload = buildGeneratePayload({
    material: null, question: "问题", rubricSchema: verifiedSchemaFixture,
    answerMinutes: 2, targetMinWords: 420, targetWords: 520, targetMaxWords: 620,
    previousFeedback: null
  });
  assert.equal("rubric" in payload, false);
  assert.equal("compiled_prompt" in payload, false);
  assert.equal(payload.target_min_words, 420);
  assert.equal(payload.rubric_schema.version, "v2");
});

test("review feedback becomes the next generation repair payload", () => {
  assert.deepEqual(toRetryFeedback({
    failed_criteria: [{ criterion_id: "CRI-002", reason: "缺少闭环", repair_instruction: "补充反馈整改" }],
    preserved_criteria_ids: ["CRI-001"], reasons: ["需要形成闭环"]
  }), {
    failedCriteria: [{ criterionId: "CRI-002", reason: "缺少闭环", repairInstruction: "补充反馈整改" }],
    preservedCriteriaIds: ["CRI-001"], reasons: ["需要形成闭环"]
  });
});
```

Create the complete Worker fixture:

```typescript
// apps/worker/tests/fixtures.ts
import type { RubricSchemaV2 } from "@answer-generator/shared";

export const verifiedSchemaFixture: RubricSchemaV2 = {
  version: "v2",
  rolePrompt: "你是一名结构化面试考生。",
  sourceRequirements: [
    { id: "REQ-001", text: "准确分析问题", kind: "criterion" },
    { id: "REQ-002", text: "措施形成闭环", kind: "criterion" }
  ],
  globalConstraints: [],
  dimensions: [
    {
      id: "DIM-001", name: "综合分析", maxScore: 50, sourceRequirementIds: ["REQ-001"],
      criteria: [{ id: "CRI-001", text: "准确分析问题", sourceRequirementIds: ["REQ-001"] }],
      pitfalls: [{ id: "PIT-001", text: "只表态不分析", sourceRequirementIds: ["REQ-001"] }]
    },
    {
      id: "DIM-002", name: "解决问题", maxScore: 50, sourceRequirementIds: ["REQ-002"],
      criteria: [{ id: "CRI-002", text: "措施形成闭环", sourceRequirementIds: ["REQ-002"] }],
      pitfalls: [{ id: "PIT-002", text: "措施缺少反馈", sourceRequirementIds: ["REQ-002"] }]
    }
  ],
  answerPrinciples: ["围绕题目作答"],
  retryPolicy: ["定向修复低分项"],
  outputRules: ["输出纯文本"],
  compilation: {
    compilerModel: "test-model", auditorModel: "test-model", coveragePassed: true, inferredScores: false
  }
};
```

- [ ] **Step 2: Add Worker test script and confirm failure**

Add to `apps/worker/package.json`:

```json
"test": "tsx --test tests/**/*.test.ts"
```

Run: `pnpm --filter @answer-generator/worker test`

Expected: FAIL because `ai-payloads.ts` does not exist.

- [ ] **Step 3: Implement pure payload builders**

`buildGeneratePayload` must return only:

```typescript
{
  material,
  question,
  rubric_schema: toApiRubricSchema(rubricSchema),
  answer_minutes: answerMinutes,
  target_min_words: targetMinWords,
  target_words: targetWords,
  target_max_words: targetMaxWords,
  previous_feedback: previousFeedback ? {
    failed_criteria: previousFeedback.failedCriteria.map(item => ({
      criterion_id: item.criterionId, reason: item.reason, repair_instruction: item.repairInstruction
    })),
    preserved_criteria_ids: previousFeedback.preservedCriteriaIds,
    reasons: previousFeedback.reasons
  } : null
}
```

`buildReviewPayload` must return material, question, converted v2 Schema, answer, and passing score only. Export `toRetryFeedback` for converting API review output into the next generation input.

- [ ] **Step 4: Update orchestrator structured feedback**

Change `RunItemRequest` to the same v2-only fields as generation plus `passing_score` and `max_attempts`. In `orchestrator.py`, replace `feedback: list[str]` with `feedback: RetryFeedback | None`, and after each failed review set:

```python
feedback = RetryFeedback(
    failed_criteria=review.failed_criteria,
    preserved_criteria_ids=review.preserved_criteria_ids,
    reasons=review.reasons,
)
```

Update orchestrator tests so fake review responses include dimension IDs, failed criteria, and preserved criteria. Assert the second fake generator request receives the first review's structured feedback.

- [ ] **Step 5: Update both Worker execution paths**

In full-job and single-item paths:

- replace `Map<string, string[]>` with `Map<string, RetryFeedback>`;
- pass all three item word bounds;
- build generation/review bodies through `ai-payloads.ts`;
- store `generated.prompt_metadata` in `answerGenerationAttempts.promptMetadata`;
- store `review.failed_criteria` and `review.preserved_criteria_ids` in Review columns;
- map review dimension IDs into persisted `dimensions` objects while retaining `name`, `score`, and `maxScore`;
- feed `toRetryFeedback(review)` into the next attempt.

Update local Worker response interfaces to include `prompt_metadata`, `dimension_id`, `failed_criteria`, and `preserved_criteria_ids`. Remove all reads of `job.compiledPrompt` and all raw Rubric fields from AI payloads.

- [ ] **Step 6: Run Worker, API, and type tests**

Run: `pnpm --filter @answer-generator/worker test && pnpm typecheck`

Expected: PASS.

Run: `cd apps/api && python3 -m pytest tests/test_orchestrator.py -v`

Expected: PASS and the retry test observes structured feedback.

- [ ] **Step 7: Commit**

```bash
git add apps/worker apps/api/app/models.py apps/api/app/services/orchestrator.py apps/api/tests/test_orchestrator.py
git commit -m "feat(worker): use audited prompt pipeline payloads"
```

---

### Task 8: Complete regression coverage, documentation, and final verification

**Files:**
- Modify: `apps/api/tests/test_main.py`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Verifies the public FastAPI compilation error contract and the complete repository build.

- [ ] **Step 1: Add FastAPI endpoint contract tests**

In `apps/api/tests/test_main.py`, add tests that monkeypatch compiler behavior and assert:

```python
def test_compile_endpoint_returns_structured_failure(client, monkeypatch):
    async def fail(_request):
        raise RubricCompilationError(
            stage="auditing_repaired_schema",
            code="COVERAGE_AUDIT_FAILED",
            message="评分标准覆盖审计失败",
            details={"missing_requirement_ids": ["REQ-004"]},
        )
    monkeypatch.setattr(main, "compile_rubric", fail)
    response = client.post("/ai/compile-rubric", json={"rubric": "评分标准", "answer_minutes": 2, "passing_score": 95})
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "stage": "auditing_repaired_schema",
        "code": "COVERAGE_AUDIT_FAILED",
        "message": "评分标准覆盖审计失败",
        "details": {"missing_requirement_ids": ["REQ-004"]},
    }
```

Also assert a successful compile response contains `rubric_schema.version == "v2"` and `coverage_passed == true`.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`

Expected: shared TypeScript tests and all FastAPI tests PASS.

Run: `pnpm --filter @answer-generator/worker test`

Expected: Worker payload tests PASS.

- [ ] **Step 3: Run static verification and build**

Run: `pnpm typecheck && pnpm build`

Expected: all workspaces typecheck and production builds complete successfully.

Run: `rg -n "compiledPrompt|compiled_prompt|f\"评分标准|rubric:" apps/worker/src apps/api/app/services/generator.py`

Expected: no `compiledPrompt` or `compiled_prompt` in Worker generation payloads or generator Prompt assembly; remaining `rubric` references are limited to compilation, storage, display, and export code.

- [ ] **Step 4: Update user-facing documentation**

Update both READMEs to state:

```text
创建或修改任务后，系统会先将原始评分标准编译为结构化评分规则，执行确定性校验和独立覆盖审计。只有通过审计的评分规则才能开始生成。答案生成阶段只加载已验证的结构化规则，不重复注入原始评分标准；低分重试仅加载本轮缺失的评分项和修复建议。历史任务如仍使用旧版评分规则，需要重新分析评分标准后才能再次生成。
```

Correct the existing no-key note: Rubric compilation and answer generation require `OPENAI_API_KEY`; only answer review has a deterministic local fallback.

- [ ] **Step 5: Run migration smoke check in the configured development environment**

Run: `pnpm db:migrate`

Expected: migration `0006_add_rubric_pipeline_metadata` applies successfully. If no development `DATABASE_URL` is configured, record this as an environment limitation and rely on generated SQL inspection plus CI migration execution; do not invent credentials.

- [ ] **Step 6: Inspect final diff and commit**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended files are modified.

```bash
git add README.md README.zh-CN.md apps/api/tests/test_main.py
git commit -m "docs: describe audited prompt pipeline"
```

---

## Final Acceptance Checklist

- [ ] A candidate Schema cannot pass solely because its JSON shape is valid.
- [ ] Compiler and auditor calls use independent messages and the pipeline uses at most one repair.
- [ ] Every source requirement has a valid mapping and dimension scores total 100.
- [ ] Failed compilation state survives browser refresh and prevents full-job and single-item queues.
- [ ] Raw Rubric and `compiledPrompt` are absent from v2 generation and review requests.
- [ ] Prompt Pipe loads only the required optional Sections and records the exact list.
- [ ] Reviewer ignores unknown IDs, recomputes total score, and creates structured criterion feedback.
- [ ] Full-job and single-item retry paths persist and reuse the same structured feedback contract.
- [ ] Existing v1 results remain viewable/exportable while new v1 generation is blocked.
- [ ] `pnpm test`, Worker tests, `pnpm typecheck`, and `pnpm build` pass.
