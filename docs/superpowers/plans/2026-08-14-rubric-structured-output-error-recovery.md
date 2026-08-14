# Rubric Structured Output Error Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rubric compilation use schema-constrained output with one bounded repair path, and restore persisted compilation errors after refresh.

**Architecture:** Add a provider-aware structured-output adapter that uses DeepSeek Strict Function Calling on the `/beta` endpoint and falls back deterministically to JSON Output for non-DeepSeek providers or explicit strict-capability rejection. Keep model-authored Rubric content separate from server-authored compilation metadata, preserve the existing single repair budget across structure, deterministic validation, and coverage audit, and expose persisted compilation errors through a focused Web presentation helper and component.

**Tech Stack:** Python 3, FastAPI, Pydantic 2.10, httpx, pytest/pytest-asyncio, TypeScript, React 19, Next.js 15, Node test runner with tsx, PostgreSQL/Drizzle.

## Global Constraints

- A compilation may make at most one repair call across structure repair, deterministic validation repair, and coverage-audit repair.
- Strict output is used only for `api.deepseek.com`; other OpenAI-compatible providers use the JSON Output compatibility path without a failed capability-probe request.
- DeepSeek strict calls use the official `/beta` base URL, `strict: true`, a complete JSON Schema, and forced selection of one function.
- Timeout, authentication, rate-limit, and server failures must not trigger protocol fallback.
- `compiler_model`, `auditor_model`, and `coverage_passed` are server-authored facts; the model-authored candidate contains `inferred_scores` but no `compilation` object.
- Every accepted candidate must still pass Pydantic validation, deterministic Rubric validation, and independent coverage audit.
- Failed or unaudited candidates must never be written to `rubric_schema`.
- Persisted error details must never include API keys, authorization headers, or response headers.
- Do not add an unbounded retry loop or a second repair budget.

---

## File Structure

- `apps/api/app/models.py`: shared Rubric content fields, model-authored candidate contract, and persisted/API Rubric v2 contract.
- `apps/api/app/services/structured_output.py`: provider selection, DeepSeek strict-schema normalization, strict tool payload construction, response extraction, and compatibility JSON Output transport.
- `apps/api/app/services/rubric_compiler.py`: Rubric-specific prompts, candidate-to-schema assembly, the one-repair state machine, deterministic validation, and coverage audit orchestration.
- `apps/api/tests/test_structured_output.py`: unit tests for strict schema and provider-aware transport behavior.
- `apps/api/tests/test_rubric_compiler.py`: pipeline tests for structure repair, repair-budget sharing, metadata assembly, and existing audit behavior.
- `apps/api/tests/rubric_fixtures.py`: valid candidate and complete-schema fixtures with one canonical source of test data.
- `apps/web/src/components/dashboard/types.ts`: task-detail `rubricCompilation` contract and view model type.
- `apps/web/src/components/dashboard/utils.ts`: pure conversion from persisted compilation state to a user-facing error view.
- `apps/web/src/components/dashboard/compilation-error.tsx`: accessible persistent error summary with expandable technical details.
- `apps/web/src/components/dashboard.tsx`: keep transient errors separate from task-persisted compilation errors and refresh both during polling.
- `apps/web/tests/compilation-error.test.ts`: pure helper tests run through the Node test runner.
- `apps/web/app/globals.css`: persistent error summary/detail styling.
- `apps/web/package.json` and `pnpm-lock.yaml`: add the Web test script and `tsx` development dependency.

---

### Task 1: Separate Model-Authored Rubric Content from Compilation Metadata

**Files:**
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/tests/rubric_fixtures.py`
- Modify: `apps/api/tests/test_rubric_schema.py`

**Interfaces:**
- Consumes: existing `SourceRequirement`, `RubricGlobalConstraint`, `RubricDimensionSchemaV2`, and `RubricCompilationMetadata` Pydantic models.
- Produces: `RubricSchemaContent`, `RubricSchemaCandidate`, `RubricSchemaV2`, and `build_rubric_schema(candidate: RubricSchemaCandidate, compiler_model: str) -> RubricSchemaV2`.

- [ ] **Step 1: Add failing candidate-contract tests**

Add these imports and tests to `apps/api/tests/test_rubric_schema.py`:

```python
from app.models import RubricSchemaCandidate, RubricSchemaV2, build_rubric_schema
from tests.rubric_fixtures import valid_candidate_data, valid_schema_data


def test_candidate_does_not_require_model_generated_compilation_metadata():
    candidate = RubricSchemaCandidate.model_validate(valid_candidate_data())

    assert candidate.inferred_scores is False
    assert "compilation" not in candidate.model_dump()


def test_server_builds_compilation_metadata_from_candidate():
    candidate = RubricSchemaCandidate.model_validate(valid_candidate_data())

    schema = build_rubric_schema(candidate, "deepseek-v4-pro")

    assert isinstance(schema, RubricSchemaV2)
    assert schema.compilation.compiler_model == "deepseek-v4-pro"
    assert schema.compilation.auditor_model is None
    assert schema.compilation.coverage_passed is False
    assert schema.compilation.inferred_scores is False
```

Change `valid_schema_data()` in `apps/api/tests/rubric_fixtures.py` to be assembled from a new candidate fixture:

```python
def valid_candidate_data() -> dict:
    return {
        "version": "v2",
        "role_prompt": "你是一名结构化面试考生。",
        "source_requirements": [
            {"id": "REQ-001", "text": "准确分析问题", "kind": "criterion"},
            {"id": "REQ-002", "text": "措施形成闭环", "kind": "criterion"},
        ],
        "global_constraints": [],
        "dimensions": [
            {
                "id": "DIM-001",
                "name": "综合分析",
                "max_score": 50,
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
            },
            {
                "id": "DIM-002",
                "name": "解决问题",
                "max_score": 50,
                "source_requirement_ids": ["REQ-002"],
                "criteria": [
                    {
                        "id": "CRI-002",
                        "text": "措施形成闭环",
                        "source_requirement_ids": ["REQ-002"],
                    }
                ],
                "pitfalls": [
                    {
                        "id": "PIT-002",
                        "text": "措施没有反馈",
                        "source_requirement_ids": ["REQ-002"],
                    }
                ],
            },
        ],
        "answer_principles": ["围绕题目作答"],
        "retry_policy": ["定向修复低分项"],
        "output_rules": ["输出纯文本"],
        "inferred_scores": False,
    }


def valid_schema_data() -> dict:
    candidate = valid_candidate_data()
    inferred_scores = candidate.pop("inferred_scores")
    return {
        **candidate,
        "compilation": {
            "compiler_model": "test-model",
            "auditor_model": None,
            "coverage_passed": False,
            "inferred_scores": inferred_scores,
        },
    }
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest tests/test_rubric_schema.py -q
```

Expected: collection fails because `RubricSchemaCandidate` and `build_rubric_schema` do not exist.

- [ ] **Step 3: Implement the shared content and candidate models**

Replace the duplicated content fields in `apps/api/app/models.py` with:

```python
class RubricSchemaContent(BaseModel):
    version: Literal["v2"] = "v2"
    role_prompt: str
    source_requirements: List[SourceRequirement] = Field(min_length=1)
    global_constraints: List[RubricGlobalConstraint] = Field(default_factory=list)
    dimensions: List[RubricDimensionSchemaV2] = Field(min_length=1)
    answer_principles: List[str] = Field(default_factory=list)
    retry_policy: List[str] = Field(default_factory=list)
    output_rules: List[str] = Field(default_factory=list)


class RubricSchemaCandidate(RubricSchemaContent):
    inferred_scores: bool = False


class RubricSchemaV2(RubricSchemaContent):
    compilation: RubricCompilationMetadata


def build_rubric_schema(
    candidate: RubricSchemaCandidate, compiler_model: str
) -> RubricSchemaV2:
    candidate_data = candidate.model_dump()
    inferred_scores = candidate_data.pop("inferred_scores")
    return RubricSchemaV2.model_validate(
        {
            **candidate_data,
            "compilation": {
                "compiler_model": compiler_model,
                "auditor_model": None,
                "coverage_passed": False,
                "inferred_scores": inferred_scores,
            },
        }
    )
```

Keep `RubricCompilationMetadata` defined before `RubricSchemaV2`. Do not change the public `CompileRubricResponse` type.

- [ ] **Step 4: Run Rubric model and validation tests**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest tests/test_rubric_schema.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit the candidate boundary**

```bash
git add apps/api/app/models.py apps/api/tests/rubric_fixtures.py apps/api/tests/test_rubric_schema.py
git commit -m "refactor(api): separate rubric candidate metadata"
```

---

### Task 2: Add Provider-Aware Strict Structured Output

**Files:**
- Create: `apps/api/app/services/structured_output.py`
- Create: `apps/api/tests/test_structured_output.py`

**Interfaces:**
- Consumes: any Pydantic `BaseModel` subclass and an existing `httpx.AsyncClient`.
- Produces: `StrictOutputUnsupported`, `deepseek_strict_base_url(base_url: str) -> str | None`, `strict_json_schema(model_type: type[BaseModel]) -> dict[str, Any]`, and `post_structured_completion(...) -> dict[str, Any]`.

- [ ] **Step 1: Write failing strict-schema and provider-selection tests**

Create `apps/api/tests/test_structured_output.py` with:

```python
import json

import httpx
import pytest

from app.models import RubricSchemaCandidate
from app.services.structured_output import (
    StrictOutputUnsupported,
    deepseek_strict_base_url,
    post_structured_completion,
    strict_json_schema,
)
from tests.rubric_fixtures import valid_candidate_data


def assert_strict_objects(node: object) -> None:
    if isinstance(node, dict):
        if node.get("type") == "object":
            properties = node.get("properties", {})
            assert node.get("additionalProperties") is False
            assert set(node.get("required", [])) == set(properties)
        assert "$ref" not in node
        assert "$defs" not in node
        for value in node.values():
            assert_strict_objects(value)
    elif isinstance(node, list):
        for value in node:
            assert_strict_objects(value)


def test_deepseek_strict_base_url_is_deterministic():
    assert deepseek_strict_base_url("https://api.deepseek.com") == "https://api.deepseek.com/beta"
    assert deepseek_strict_base_url("https://api.deepseek.com/v1") == "https://api.deepseek.com/beta"
    assert deepseek_strict_base_url("https://api.openai.com/v1") is None


def test_strict_schema_inlines_refs_and_requires_every_property():
    schema = strict_json_schema(RubricSchemaCandidate)

    assert_strict_objects(schema)
    assert "inferred_scores" in schema["required"]
```

- [ ] **Step 2: Add failing transport tests for strict and compatibility modes**

Append to `apps/api/tests/test_structured_output.py`:

```python
class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)
        self.request = httpx.Request("POST", "https://api.deepseek.com/chat/completions")

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "request failed", request=self.request, response=self
            )


class FakeClient:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def post(self, url, headers, json):
        self.calls.append((url, json))
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_deepseek_uses_forced_strict_function_call():
    candidate = valid_candidate_data()
    client = FakeClient(
        [
            FakeResponse(
                {
                    "choices": [
                        {
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "function": {
                                            "name": "submit_rubric_schema",
                                            "arguments": json.dumps(candidate),
                                        }
                                    }
                                ],
                            }
                        }
                    ]
                }
            )
        ]
    )

    result = await post_structured_completion(
        client=client,
        base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
        api_key="test-key",
        prompt="return JSON",
        system_prompt="compile rubric",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="Submit the complete rubric schema candidate.",
    )

    url, payload = client.calls[0]
    assert url == "https://api.deepseek.com/beta/chat/completions"
    assert payload["tools"][0]["function"]["strict"] is True
    assert payload["tool_choice"]["function"]["name"] == "submit_rubric_schema"
    assert result == candidate


@pytest.mark.asyncio
async def test_non_deepseek_uses_json_output_without_probe_request():
    candidate = valid_candidate_data()
    client = FakeClient(
        [
            FakeResponse(
                {"choices": [{"message": {"content": json.dumps(candidate)}}]}
            )
        ]
    )

    result = await post_structured_completion(
        client=client,
        base_url="https://example.test/v1",
        model="compatible-model",
        api_key="test-key",
        prompt="return JSON",
        system_prompt="compile rubric",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="Submit the complete rubric schema candidate.",
    )

    assert len(client.calls) == 1
    assert client.calls[0][0] == "https://example.test/v1/chat/completions"
    assert client.calls[0][1]["response_format"] == {"type": "json_object"}
    assert result == candidate


@pytest.mark.asyncio
async def test_strict_capability_rejection_falls_back_once_to_json_output():
    candidate = valid_candidate_data()
    client = FakeClient(
        [
            FakeResponse(
                {"error": {"message": "strict mode is not supported"}},
                status_code=400,
            ),
            FakeResponse(
                {"choices": [{"message": {"content": json.dumps(candidate)}}]}
            ),
        ]
    )

    result = await post_structured_completion(
        client=client,
        base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
        api_key="test-key",
        prompt="return JSON",
        system_prompt="compile rubric",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="Submit the complete rubric schema candidate.",
    )

    assert len(client.calls) == 2
    assert client.calls[1][0] == "https://api.deepseek.com/chat/completions"
    assert result == candidate


@pytest.mark.asyncio
async def test_authentication_failure_does_not_fall_back():
    client = FakeClient(
        [FakeResponse({"error": {"message": "invalid api key"}}, status_code=401)]
    )

    with pytest.raises(httpx.HTTPStatusError):
        await post_structured_completion(
            client=client,
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            api_key="test-key",
            prompt="return JSON",
            system_prompt="compile rubric",
            output_model=RubricSchemaCandidate,
            function_name="submit_rubric_schema",
            function_description="Submit the complete rubric schema candidate.",
        )

    assert len(client.calls) == 1
```

- [ ] **Step 3: Run the structured-output tests and verify they fail**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest tests/test_structured_output.py -q
```

Expected: collection fails because `app.services.structured_output` does not exist.

- [ ] **Step 4: Implement strict schema normalization and provider selection**

Create `apps/api/app/services/structured_output.py` beginning with:

```python
import json
from copy import deepcopy
from typing import Any
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel


class StrictOutputUnsupported(RuntimeError):
    pass


def deepseek_strict_base_url(base_url: str) -> str | None:
    parsed = urlparse(base_url)
    if parsed.hostname != "api.deepseek.com":
        return None
    return f"{parsed.scheme}://{parsed.netloc}/beta"


def strict_json_schema(model_type: type[BaseModel]) -> dict[str, Any]:
    source = model_type.model_json_schema()
    definitions = source.pop("$defs", {})

    def normalize(node: Any) -> Any:
        if isinstance(node, list):
            return [normalize(value) for value in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            name = node["$ref"].removeprefix("#/$defs/")
            return normalize(deepcopy(definitions[name]))

        normalized = {
            key: normalize(value)
            for key, value in node.items()
            if key not in {"$defs", "default"}
        }
        if normalized.get("type") == "object":
            properties = normalized.get("properties", {})
            normalized["required"] = list(properties)
            normalized["additionalProperties"] = False
        return normalized

    return normalize(source)
```

- [ ] **Step 5: Implement strict transport, narrow fallback, and response extraction**

Continue `apps/api/app/services/structured_output.py` with:

```python
STRICT_UNSUPPORTED_MARKERS = (
    "strict mode",
    "strict is not supported",
    "unsupported json schema",
    "invalid function schema",
    "beta feature",
)


async def post_structured_completion(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    prompt: str,
    system_prompt: str,
    output_model: type[BaseModel],
    function_name: str,
    function_description: str,
) -> dict[str, Any]:
    strict_base_url = deepseek_strict_base_url(base_url)
    if strict_base_url:
        try:
            return await _post_strict(
                client,
                strict_base_url,
                model,
                api_key,
                prompt,
                system_prompt,
                output_model,
                function_name,
                function_description,
            )
        except StrictOutputUnsupported:
            pass

    return await _post_json(
        client, base_url, model, api_key, prompt, system_prompt
    )


async def _post_strict(
    client,
    base_url,
    model,
    api_key,
    prompt,
    system_prompt,
    output_model,
    function_name,
    function_description,
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
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": function_name,
                        "strict": True,
                        "description": function_description,
                        "parameters": strict_json_schema(output_model),
                    },
                }
            ],
            "tool_choice": {
                "type": "function",
                "function": {"name": function_name},
            },
        },
    )
    if response.status_code in {400, 404, 422} and any(
        marker in response.text.lower() for marker in STRICT_UNSUPPORTED_MARKERS
    ):
        raise StrictOutputUnsupported(response.text)
    response.raise_for_status()
    message = response.json()["choices"][0]["message"]
    tool_calls = message["tool_calls"]
    selected = next(
        call for call in tool_calls if call["function"]["name"] == function_name
    )
    return json.loads(selected["function"]["arguments"])


async def _post_json(
    client, base_url, model, api_key, prompt, system_prompt
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
    return json.loads(response.json()["choices"][0]["message"]["content"])
```

Do not catch timeout, 401, 403, 429, or 5xx responses inside this adapter.

- [ ] **Step 6: Run the focused tests**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest tests/test_structured_output.py -q
```

Expected: all tests pass.

- [ ] **Step 7: Commit the structured-output adapter**

```bash
git add apps/api/app/services/structured_output.py apps/api/tests/test_structured_output.py
git commit -m "feat(api): add strict structured output adapter"
```

---

### Task 3: Integrate One-Budget Structure Repair into Rubric Compilation

**Files:**
- Modify: `apps/api/app/services/rubric_compiler.py`
- Modify: `apps/api/tests/test_rubric_compiler.py`

**Interfaces:**
- Consumes: `RubricSchemaCandidate`, `build_rubric_schema`, and `post_structured_completion(...)` from Tasks 1 and 2.
- Produces: `_compile_candidate_data(...) -> dict[str, Any]`, `_repair_invalid_candidate(...) -> RubricSchemaCandidate`, `_candidate_from_data(...) -> RubricSchemaCandidate`, and the existing `compile_rubric(...) -> CompileRubricResponse` behavior with a shared single repair budget.

- [ ] **Step 1: Update the fake completion transport to support strict tool responses**

In `apps/api/tests/test_rubric_compiler.py`, replace the string-only fake with a response-factory helper:

```python
def strict_response(name: str, payload: dict) -> dict:
    return {
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "function": {
                                "name": name,
                                "arguments": json.dumps(payload, ensure_ascii=False),
                            }
                        }
                    ],
                }
            }
        ]
    }


def json_response(payload: dict) -> dict:
    return {
        "choices": [
            {"message": {"content": json.dumps(payload, ensure_ascii=False)}}
        ]
    }


def install_fake_completions(monkeypatch, responses: list[dict]) -> list[dict]:
    calls: list[dict] = []

    class FakeResponse:
        def __init__(self, payload: dict):
            self.payload = payload
            self.status_code = 200
            self.text = json.dumps(payload, ensure_ascii=False)

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            self.responses = [FakeResponse(payload) for payload in responses]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            calls.append({"url": url, "payload": json})
            return self.responses.pop(0)

    monkeypatch.setattr(rubric_compiler.httpx, "AsyncClient", FakeAsyncClient)
    return calls
```

Set `OPENAI_BASE_URL=https://api.deepseek.com` in strict-path tests and wrap candidate/audit payloads with the corresponding strict function names. Keep explicit JSON compatibility tests on a non-DeepSeek base URL.

- [ ] **Step 2: Add failing tests for server metadata and structure repair**

Append tests using `valid_candidate_data()`:

```python
@pytest.mark.asyncio
async def test_compile_pipeline_attaches_server_owned_metadata(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.deepseek.com")
    install_fake_completions(
        monkeypatch,
        [
            strict_response("submit_rubric_schema", valid_candidate_data()),
            strict_response("submit_coverage_audit", audit_result()),
        ],
    )

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.compilation.compiler_model == "gpt-4o-mini"
    assert result.rubric_schema.compilation.auditor_model == "gpt-4o-mini"
    assert result.rubric_schema.compilation.coverage_passed is True


@pytest.mark.asyncio
async def test_invalid_candidate_shape_is_repaired_once(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.test/v1")
    invalid = valid_candidate_data()
    invalid["answer_principles"] = {"general": ["围绕题目作答"]}
    calls = install_fake_completions(
        monkeypatch,
        [
            json_response(invalid),
            json_response(valid_candidate_data()),
            json_response(audit_result()),
        ],
    )

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.compilation.coverage_passed is True
    assert len(calls) == 3
    repair_prompt = calls[1]["payload"]["messages"][1]["content"]
    assert "answer_principles" in repair_prompt
    assert "Input should be a valid list" in repair_prompt


@pytest.mark.asyncio
async def test_structure_repair_consumes_the_only_repair_budget(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.test/v1")
    invalid = valid_candidate_data()
    invalid["retry_policy"] = {"max_retries": 2}
    calls = install_fake_completions(
        monkeypatch,
        [
            json_response(invalid),
            json_response(valid_candidate_data()),
            json_response(audit_result(False)),
        ],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.code == "COVERAGE_AUDIT_FAILED"
    assert len(calls) == 3
```

- [ ] **Step 3: Run the focused compiler tests and confirm they fail**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest tests/test_rubric_compiler.py -q
```

Expected: failures show the compiler still validates a full `RubricSchemaV2` directly and aborts before structure repair.

- [ ] **Step 4: Route all typed Rubric stages through the structured-output adapter**

In `apps/api/app/services/rubric_compiler.py`, import:

```python
from app.models import (
    CompileRubricRequest,
    CompileRubricResponse,
    CoverageAuditResult,
    RubricSchemaCandidate,
    RubricSchemaV2,
    build_rubric_schema,
)
from app.services.structured_output import post_structured_completion
```

Replace `_post_json_completion` calls in candidate and audit stages with:

```python
async def _compile_candidate_data(client, base_url, model, api_key, request):
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


async def _audit_candidate(client, base_url, model, api_key, request, schema):
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
```

Use the same `submit_rubric_schema` contract for both structure repair and business/audit repair.

- [ ] **Step 5: Implement candidate validation and the single repair state machine**

Add helpers:

```python
def _candidate_from_data(data: dict[str, Any]) -> RubricSchemaCandidate:
    return RubricSchemaCandidate.model_validate(data)


async def _repair_invalid_candidate(
    client,
    base_url,
    model,
    api_key,
    request,
    candidate_data,
    error,
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
```

Reshape `_compile_with_openai` so the start of the pipeline is:

```python
candidate_data = await _run_compile_stage(
    "compiling_schema",
    _compile_candidate_data(client, base_url, model, api_key, request),
)
repair_used = False
try:
    candidate = _candidate_from_data(candidate_data)
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
```

Keep the deterministic validation and audit sequence after candidate assembly. Apply these exact budget rules:

```python
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
```

After the first audit, use:

```python
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
        _audit_candidate(client, base_url, model, api_key, request, schema),
    )
    _validate_audit_result("auditing_repaired_schema", audit)
    if not audit.passed:
        raise _coverage_failure("auditing_repaired_schema", audit)
```

A structure repair followed by failed coverage audit therefore raises without another model repair call.

- [ ] **Step 6: Add a complete fallback example and structure-repair prompt**

Define a production example constant in `rubric_compiler.py` using all candidate fields, including empty `global_constraints` and boolean `inferred_scores`. Append it to `_build_compile_prompt`:

```python
f"完整 JSON 形状示例：\n{json.dumps(RUBRIC_CANDIDATE_EXAMPLE, ensure_ascii=False)}\n\n"
```

Remove `compilation` from the requested model fields and replace the old instruction with:

```text
只返回候选业务字段；不要返回 compilation。inferred_scores 必须是布尔值。
```

Add:

```python
def _build_structure_repair_prompt(request, candidate_data, errors) -> str:
    return (
        "只修复结构校验报告指出的问题，输出完整候选 JSON，不要返回 compilation。\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"无效候选 JSON：\n{json.dumps(candidate_data, ensure_ascii=False)}\n\n"
        f"Pydantic 结构错误：\n{json.dumps(errors, ensure_ascii=False)}\n\n"
        f"完整 JSON 形状示例：\n{json.dumps(RUBRIC_CANDIDATE_EXAMPLE, ensure_ascii=False)}"
    )
```

- [ ] **Step 7: Run compiler and API tests**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest tests/test_rubric_compiler.py tests/test_rubric_schema.py tests/test_main.py -q
```

Expected: all selected tests pass. In every pre-existing compiler test, replace compile-stage and repair-stage `valid_schema_data()` responses with `valid_candidate_data()` responses; leave `audit_result()` responses unchanged. Preserve all existing assertions about repair count and audit stages.

- [ ] **Step 8: Commit the bounded Rubric pipeline**

```bash
git add apps/api/app/services/rubric_compiler.py apps/api/tests/test_rubric_compiler.py
git commit -m "fix(api): repair invalid rubric structures once"
```

---

### Task 4: Restore Persisted Compilation Errors in the Dashboard

**Files:**
- Modify: `apps/web/src/components/dashboard/types.ts`
- Modify: `apps/web/src/components/dashboard/utils.ts`
- Create: `apps/web/src/components/dashboard/compilation-error.tsx`
- Modify: `apps/web/src/components/dashboard.tsx`
- Create: `apps/web/tests/compilation-error.test.ts`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: shared `RubricCompilationState` returned as `job.rubricCompilation` by the existing task-detail endpoint.
- Produces: `CompilationErrorView`, `compilationErrorView(state) -> CompilationErrorView | null`, and `CompilationError` React component.

- [ ] **Step 1: Add the Web test runner**

Update `apps/web/package.json`:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "test": "tsx --test tests/*.test.ts",
  "typecheck": "tsc --noEmit",
  "lint": "next lint"
},
"devDependencies": {
  "@types/node": "^22.10.5",
  "@types/react": "^19.0.4",
  "@types/react-dom": "^19.0.2",
  "tsx": "^4.20.3",
  "typescript": "^5.8.3"
}
```

Run:

```bash
pnpm install
```

Expected: `pnpm-lock.yaml` records `tsx` for the Web importer, the Web package receives its executable link, and unrelated dependency versions remain unchanged.

- [ ] **Step 2: Write failing pure error-view tests**

Create `apps/web/tests/compilation-error.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the Web tests and verify they fail**

Run:

```bash
pnpm --filter @answer-generator/web test
```

Expected: TypeScript import fails because `compilationErrorView` does not exist.

- [ ] **Step 4: Add task-detail types and the pure formatter**

In `apps/web/src/components/dashboard/types.ts`, import the shared type and add:

```typescript
import type { GenerationJobStatus, RubricCompilationState } from "@answer-generator/shared";

export interface CompilationErrorView {
  title: string;
  message: string;
  meta: string;
  technicalDetails: string | null;
}
```

Change `JobDetailPayload.job.status` to `GenerationJobStatus` and add:

```typescript
rubricCompilation: RubricCompilationState | null;
```

In `apps/web/src/components/dashboard/utils.ts`, import `RubricCompilationState` and `CompilationErrorView`, then add:

```typescript
export function compilationErrorView(
  state: RubricCompilationState | null | undefined
): CompilationErrorView | null {
  if (!state?.code || !state.message) {
    return null;
  }

  return {
    title: "评分标准分析失败",
    message: state.message,
    meta: `${state.stage} · ${state.code}`,
    technicalDetails:
      typeof state.details?.error === "string" ? state.details.error : null
  };
}
```

- [ ] **Step 5: Implement the accessible persistent-error component**

Create `apps/web/src/components/dashboard/compilation-error.tsx`:

```tsx
import type { CompilationErrorView } from "./types";

export function CompilationError({ error }: { error: CompilationErrorView }) {
  return (
    <section className="compilation-error" role="alert">
      <strong>{error.title}</strong>
      <p>{error.message}</p>
      <span>{error.meta}</span>
      {error.technicalDetails ? (
        <details>
          <summary>查看技术详情</summary>
          <pre>{error.technicalDetails}</pre>
        </details>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 6: Keep persisted and transient errors separate in Dashboard**

In `apps/web/src/components/dashboard.tsx`:

```typescript
import { CompilationError } from "./dashboard/compilation-error";
import {
  compilationErrorView,
  formatBlock,
  formatBlocks,
  formatElapsed,
  latestReviewReasons,
  normalizeApiError,
  parseAnswerSections,
  parseBlocks,
  validateTaskForm
} from "./dashboard/utils";
import type { CompilationErrorView } from "./dashboard/types";
```

Add state beside `error`:

```typescript
const [rubricCompilationError, setRubricCompilationError] =
  useState<CompilationErrorView | null>(null);
```

In `loadJobDetail`, after setting `activeJobStatus`, always update it—even during silent polling:

```typescript
setRubricCompilationError(
  compilationErrorView(payload.job.rubricCompilation)
);
```

When deleting the active task, also call:

```typescript
setRubricCompilationError(null);
```

Do not clear `rubricCompilationError` at the start of `loadJobDetail`; the new payload is the authority. A task in `compiling_schema` without `code` and a completed compilation naturally produce `null` through the pure formatter.

Render the persisted error independently from transient `error`:

```tsx
{rubricCompilationError ? (
  <CompilationError error={rubricCompilationError} />
) : null}
{error ? <div className="error">{error}</div> : null}
```

- [ ] **Step 7: Add persistent-error styling**

Append to `apps/web/app/globals.css`:

```css
.compilation-error {
  border-left: 2px solid var(--danger);
  padding: 12px 14px;
  color: var(--danger);
}

.compilation-error p {
  margin: 4px 0;
}

.compilation-error span,
.compilation-error summary {
  font-size: 12px;
}

.compilation-error details {
  margin-top: 8px;
}

.compilation-error summary {
  cursor: pointer;
}

.compilation-error pre {
  max-height: 240px;
  margin: 8px 0 0;
  overflow: auto;
  white-space: pre-wrap;
  color: var(--muted);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
```

- [ ] **Step 8: Run Web tests and type checking**

Run:

```bash
pnpm --filter @answer-generator/web test
pnpm --filter @answer-generator/web typecheck
```

Expected: all helper tests pass and TypeScript reports no errors.

- [ ] **Step 9: Commit persisted error recovery**

```bash
git add apps/web/src/components/dashboard/types.ts apps/web/src/components/dashboard/utils.ts apps/web/src/components/dashboard/compilation-error.tsx apps/web/src/components/dashboard.tsx apps/web/tests/compilation-error.test.ts apps/web/app/globals.css apps/web/package.json pnpm-lock.yaml
git commit -m "fix(web): restore rubric compilation errors"
```

---

### Task 5: Full Regression and Real-Task Verification

**Files:**
- Modify only if a test exposes a defect in files already listed above.

**Interfaces:**
- Consumes: completed strict-output pipeline and persistent-error UI.
- Produces: verified workspace with no unrelated changes and an evidence-backed handoff.

- [ ] **Step 1: Run the full API suite**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest -q
```

Expected: all API tests pass.

- [ ] **Step 2: Run all JavaScript/TypeScript tests**

Run:

```bash
pnpm --filter @answer-generator/shared test
pnpm --filter @answer-generator/worker test
pnpm --filter @answer-generator/web test
```

Expected: all test suites pass.

- [ ] **Step 3: Run workspace type checking and the production Web build**

Run:

```bash
pnpm typecheck
pnpm --filter @answer-generator/web build
```

Expected: all packages type-check and Next.js completes a production build.

- [ ] **Step 4: Verify persisted failure recovery against the reported task**

Start the API and Web services using the existing development commands, open task `f99f8143-7744-4055-845a-a6c60ce4dd40`, and verify:

1. Its existing `rubricCompilation` record renders “评分标准分析失败”.
2. The banner shows `compiling_schema · INVALID_MODEL_RESPONSE`.
3. “查看技术详情” reveals the saved Pydantic validation text.
4. Reloading the page preserves the banner.
5. Selecting another task and returning restores the banner again.

This step is read-only for the reported failed task. Do not re-run its compilation until the user explicitly requests a real paid model retry.

- [ ] **Step 5: Inspect the final diff and repository state**

Run:

```bash
git status --short
git diff --check HEAD~3..HEAD
git log -5 --oneline
```

Expected: no uncommitted changes, no whitespace errors, and the four implementation commits appear after the design/plan commits.

- [ ] **Step 6: Commit only if regression fixes were required**

If Step 1-4 required changes, stage the known implementation files and commit:

```bash
git add apps/api/app/models.py apps/api/app/services/structured_output.py apps/api/app/services/rubric_compiler.py apps/api/tests/rubric_fixtures.py apps/api/tests/test_rubric_schema.py apps/api/tests/test_structured_output.py apps/api/tests/test_rubric_compiler.py apps/web/src/components/dashboard/types.ts apps/web/src/components/dashboard/utils.ts apps/web/src/components/dashboard/compilation-error.tsx apps/web/src/components/dashboard.tsx apps/web/tests/compilation-error.test.ts apps/web/app/globals.css apps/web/package.json pnpm-lock.yaml
git commit -m "fix: address structured output regressions"
```

If no fixes were required, do not create an empty commit.
