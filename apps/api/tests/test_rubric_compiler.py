import json

import httpx
import pytest

from app.models import CompileRubricRequest
from app.services.rubric_compiler import (
    RubricCompilationError,
    _compile_with_openai,
    compile_rubric,
)
import app.services.rubric_compiler as rubric_compiler
from tests.rubric_fixtures import valid_candidate_data, valid_schema_data


@pytest.fixture(autouse=True)
def stable_model_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")


def make_request() -> CompileRubricRequest:
    return CompileRubricRequest(
        rubric="综合分析50分，解决问题50分。",
        answer_minutes=2,
        passing_score=95,
    )


def install_fake_completions(monkeypatch, responses: list[str]) -> list[dict]:
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
            self.responses = list(responses)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            calls.append(json)
            content = self.responses.pop(0)
            if "tools" in json:
                function_name = json["tool_choice"]["function"]["name"]
                return FakeResponse(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": None,
                                    "tool_calls": [
                                        {
                                            "function": {
                                                "name": function_name,
                                                "arguments": content,
                                            }
                                        }
                                    ],
                                }
                            }
                        ]
                    }
                )
            return FakeResponse(
                {"choices": [{"message": {"content": content}}]}
            )

    monkeypatch.setattr(rubric_compiler.httpx, "AsyncClient", FakeAsyncClient)
    return calls


def audit_result(passed: bool = True) -> dict:
    return {
        "passed": passed,
        "missing_requirement_ids": [] if passed else ["REQ-002"],
        "unsupported_schema_paths": [],
        "conflicts": [],
        "score_issues": [],
        "repair_instructions": [] if passed else ["补充 REQ-002 映射"],
    }


@pytest.mark.asyncio
async def test_compile_rubric_requires_ai_configuration(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        await compile_rubric(make_request())


@pytest.mark.asyncio
async def test_compile_stage_preserves_http_error_response_body():
    request = httpx.Request("POST", "https://api.deepseek.com/beta/chat/completions")
    response = httpx.Response(
        400,
        request=request,
        json={"error": {"message": "Invalid schema: unsupported keyword title"}},
    )

    async def fail():
        raise httpx.HTTPStatusError(
            "400 Bad Request", request=request, response=response
        )

    with pytest.raises(RubricCompilationError) as error:
        await rubric_compiler._run_compile_stage("compiling_schema", fail())

    assert error.value.details["status_code"] == 400
    assert "unsupported keyword title" in error.value.details["response_body"]


@pytest.mark.asyncio
async def test_compile_pipeline_compiles_and_audits_without_repair(monkeypatch):
    responses = [
        json.dumps(valid_schema_data(), ensure_ascii=False),
        json.dumps(audit_result(), ensure_ascii=False),
    ]
    calls = install_fake_completions(monkeypatch, responses)

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.version == "v2"
    assert result.rubric_schema.compilation.coverage_passed is True
    assert result.rubric_schema.compilation.auditor_model == "gpt-4o-mini"
    assert len(calls) == 2
    assert len(calls[0]["messages"]) == 2
    assert len(calls[1]["messages"]) == 2
    assert "评分标准编译器" in calls[0]["messages"][0]["content"]
    assert "独立的评分标准覆盖审计员" in calls[1]["messages"][0]["content"]
    assert "独立审计" in calls[1]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_compile_pipeline_repairs_once_after_failed_validation(monkeypatch):
    invalid = valid_schema_data()
    invalid["dimensions"][1]["max_score"] = 40
    calls = install_fake_completions(
        monkeypatch,
        [
            json.dumps(invalid, ensure_ascii=False),
            json.dumps(valid_schema_data(), ensure_ascii=False),
            json.dumps(audit_result(), ensure_ascii=False),
        ],
    )

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.compilation.coverage_passed is True
    assert len(calls) == 3
    assert "INVALID_SCORE_TOTAL" in calls[1]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_compile_pipeline_repairs_once_after_failed_audit(monkeypatch):
    first = valid_schema_data()
    first["source_requirements"].append(
        {"id": "REQ-003", "text": "关注群众诉求", "kind": "criterion"}
    )
    first["dimensions"][1]["source_requirement_ids"].append("REQ-003")
    repaired = valid_schema_data()
    repaired["source_requirements"].append(
        {"id": "REQ-003", "text": "关注群众诉求", "kind": "criterion"}
    )
    repaired["dimensions"][1]["criteria"].append(
        {
            "id": "CRI-003",
            "text": "关注群众诉求",
            "source_requirement_ids": ["REQ-003"],
        }
    )
    repaired["dimensions"][1]["source_requirement_ids"].append("REQ-003")
    failed_audit = audit_result(False)
    failed_audit["missing_requirement_ids"] = ["REQ-003"]
    failed_audit["repair_instructions"] = ["新增群众诉求 criterion 并映射 REQ-003"]
    calls = install_fake_completions(
        monkeypatch,
        [
            json.dumps(first, ensure_ascii=False),
            json.dumps(failed_audit, ensure_ascii=False),
            json.dumps(repaired, ensure_ascii=False),
            json.dumps(audit_result(), ensure_ascii=False),
        ],
    )

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.compilation.coverage_passed is True
    assert len(calls) == 4


@pytest.mark.asyncio
async def test_compile_pipeline_fails_after_single_repair(monkeypatch):
    calls = install_fake_completions(
        monkeypatch,
        [
            json.dumps(valid_schema_data(), ensure_ascii=False),
            json.dumps(audit_result(False), ensure_ascii=False),
            json.dumps(valid_schema_data(), ensure_ascii=False),
            json.dumps(audit_result(False), ensure_ascii=False),
        ],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "auditing_repaired_schema"
    assert error.value.code == "COVERAGE_AUDIT_FAILED"
    assert len(calls) == 4


@pytest.mark.asyncio
async def test_compile_pipeline_does_not_repair_again_after_validation_repair(
    monkeypatch,
):
    invalid = valid_schema_data()
    invalid["dimensions"][1]["max_score"] = 40
    calls = install_fake_completions(
        monkeypatch,
        [
            json.dumps(invalid, ensure_ascii=False),
            json.dumps(valid_schema_data(), ensure_ascii=False),
            json.dumps(audit_result(False), ensure_ascii=False),
        ],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "auditing_repaired_schema"
    assert error.value.code == "COVERAGE_AUDIT_FAILED"
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_compile_pipeline_reports_invalid_compile_json(monkeypatch):
    install_fake_completions(monkeypatch, ["not json"])

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "compiling_schema"
    assert error.value.code == "INVALID_MODEL_RESPONSE"


@pytest.mark.asyncio
async def test_compile_pipeline_reports_invalid_audit_json(monkeypatch):
    install_fake_completions(
        monkeypatch,
        [json.dumps(valid_schema_data(), ensure_ascii=False), "not json"],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "auditing_coverage"
    assert error.value.code == "INVALID_MODEL_RESPONSE"


@pytest.mark.asyncio
async def test_compile_pipeline_reports_invalid_repair_json(monkeypatch):
    install_fake_completions(
        monkeypatch,
        [
            json.dumps(valid_schema_data(), ensure_ascii=False),
            json.dumps(audit_result(False), ensure_ascii=False),
            "not json",
        ],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "repairing_schema"
    assert error.value.code == "INVALID_MODEL_RESPONSE"


@pytest.mark.asyncio
async def test_compile_pipeline_rejects_contradictory_passed_audit(monkeypatch):
    contradictory = audit_result()
    contradictory["missing_requirement_ids"] = ["REQ-002"]
    install_fake_completions(
        monkeypatch,
        [
            json.dumps(valid_schema_data(), ensure_ascii=False),
            json.dumps(contradictory, ensure_ascii=False),
        ],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "auditing_coverage"
    assert error.value.code == "INVALID_MODEL_RESPONSE"


@pytest.mark.asyncio
async def test_compile_pipeline_rejects_failed_audit_without_issues(monkeypatch):
    empty_failure = audit_result()
    empty_failure["passed"] = False
    install_fake_completions(
        monkeypatch,
        [
            json.dumps(valid_schema_data(), ensure_ascii=False),
            json.dumps(empty_failure, ensure_ascii=False),
        ],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "auditing_coverage"
    assert error.value.code == "INVALID_MODEL_RESPONSE"


@pytest.mark.parametrize(
    ("raised", "code"),
    [
        (httpx.ReadTimeout("model request timed out"), "AI_SERVICE_TIMEOUT"),
        (httpx.ConnectError("model unavailable"), "AI_SERVICE_ERROR"),
    ],
)
@pytest.mark.asyncio
async def test_compile_pipeline_wraps_model_transport_errors(
    monkeypatch, raised, code
):
    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            raise raised

    monkeypatch.setattr(rubric_compiler.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.stage == "compiling_schema"
    assert error.value.code == code


@pytest.mark.asyncio
async def test_compile_with_openai_uses_configured_timeout(monkeypatch):
    captured_timeout = None

    class FakeResponse:
        def __init__(self, content: str):
            self.content = content

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": self.content}}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            nonlocal captured_timeout
            captured_timeout = kwargs.get("timeout")
            self.responses = [
                FakeResponse(json.dumps(valid_schema_data(), ensure_ascii=False)),
                FakeResponse(json.dumps(audit_result(), ensure_ascii=False)),
            ]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            return self.responses.pop(0)

    monkeypatch.setenv("OPENAI_TIMEOUT_SECONDS", "180")
    monkeypatch.setattr(rubric_compiler.httpx, "AsyncClient", FakeAsyncClient)

    await _compile_with_openai(make_request(), "test-key")

    assert captured_timeout == 180


@pytest.mark.asyncio
async def test_compile_pipeline_attaches_server_owned_metadata(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("OPENAI_MODEL", "deepseek-v4-pro")
    install_fake_completions(
        monkeypatch,
        [
            json.dumps(valid_candidate_data(), ensure_ascii=False),
            json.dumps(audit_result(), ensure_ascii=False),
        ],
    )

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.compilation.compiler_model == "deepseek-v4-pro"
    assert result.rubric_schema.compilation.auditor_model == "deepseek-v4-pro"
    assert result.rubric_schema.compilation.coverage_passed is True


@pytest.mark.asyncio
async def test_invalid_candidate_shape_is_repaired_once(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example.test/v1")
    invalid = valid_candidate_data()
    invalid["answer_principles"] = {"general": ["围绕题目作答"]}
    calls = install_fake_completions(
        monkeypatch,
        [
            json.dumps(invalid, ensure_ascii=False),
            json.dumps(valid_candidate_data(), ensure_ascii=False),
            json.dumps(audit_result(), ensure_ascii=False),
        ],
    )

    result = await _compile_with_openai(make_request(), "test-key")

    assert result.rubric_schema.compilation.coverage_passed is True
    assert len(calls) == 3
    repair_prompt = calls[1]["messages"][1]["content"]
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
            json.dumps(invalid, ensure_ascii=False),
            json.dumps(valid_candidate_data(), ensure_ascii=False),
            json.dumps(audit_result(False), ensure_ascii=False),
        ],
    )

    with pytest.raises(RubricCompilationError) as error:
        await _compile_with_openai(make_request(), "test-key")

    assert error.value.code == "COVERAGE_AUDIT_FAILED"
    assert len(calls) == 3
