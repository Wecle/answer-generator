import pytest

from app.models import CompileRubricRequest
import app.services.rubric_compiler as rubric_compiler
from app.services.rubric_compiler import _compile_with_openai, _schema_from_data, compile_rubric


@pytest.mark.asyncio
async def test_compile_rubric_requires_ai_configuration(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        await compile_rubric(
            CompileRubricRequest(
                rubric="审题准确度15分，论证思维20分。",
                answer_minutes=3,
                passing_score=95,
            )
        )


def test_schema_from_data_rejects_invalid_ai_schema_without_local_fallback():
    request = CompileRubricRequest(
        rubric="#### 维度一：审题准确度（满分15分）\n| 优 | 13-15分 | 完全切题 |",
        answer_minutes=3,
        passing_score=95,
    )

    with pytest.raises(ValueError, match="dimensions"):
        _schema_from_data({"dimensions": []}, request)


def test_schema_from_data_accepts_ai_analyzed_dimensions():
    request = CompileRubricRequest(
        rubric="任意格式评分标准，由 AI 自行理解。",
        answer_minutes=3,
        passing_score=95,
    )

    schema = _schema_from_data(
        {
            "role_prompt": "你是一名结构化面试考生。",
            "answer_principles": ["围绕题目作答。"],
            "dimensions": [
                {
                    "name": "审题准确度",
                    "max_score": 15,
                    "criteria": ["准确把握题目核心任务"],
                    "pitfalls": ["偏离题意"],
                },
                {
                    "name": "论证思维",
                    "max_score": 20,
                    "criteria": ["结构清楚，逻辑递进"],
                    "pitfalls": ["层次混乱"],
                },
            ],
            "retry_policy": ["只修复低分维度。"],
            "output_rules": ["输出纯文本。"],
        },
        request,
    )

    assert [dimension.name for dimension in schema.dimensions] == ["审题准确度", "论证思维"]
    assert [dimension.max_score for dimension in schema.dimensions] == [15, 20]


def test_schema_from_data_uses_system_policy_when_ai_omits_retry_policy():
    request = CompileRubricRequest(
        rubric="任意格式评分标准，由 AI 自行理解。",
        answer_minutes=3,
        passing_score=95,
    )

    schema = _schema_from_data(
        {
            "role_prompt": "你是一名结构化面试考生。",
            "answer_principles": ["围绕题目作答。"],
            "dimensions": [
                {
                    "name": "审题准确度",
                    "max_score": 15,
                    "criteria": ["准确把握题目核心任务"],
                    "pitfalls": ["偏离题意"],
                }
            ],
            "output_rules": ["输出纯文本。"],
        },
        request,
    )

    assert schema.retry_policy
    assert "低分维度" in schema.retry_policy[0]


def test_schema_from_data_uses_system_defaults_when_ai_omits_non_scoring_fields():
    request = CompileRubricRequest(
        rubric="任意格式评分标准，由 AI 自行理解。",
        answer_minutes=3,
        passing_score=95,
    )

    schema = _schema_from_data(
        {
            "dimensions": [
                {
                    "name": "审题准确度",
                    "max_score": 15,
                    "criteria": ["准确把握题目核心任务"],
                    "pitfalls": ["偏离题意"],
                }
            ],
        },
        request,
    )

    assert schema.role_prompt
    assert schema.answer_principles
    assert schema.retry_policy
    assert schema.output_rules
    assert schema.dimensions[0].name == "审题准确度"


@pytest.mark.asyncio
async def test_compile_with_openai_repairs_invalid_ai_schema(monkeypatch):
    request = CompileRubricRequest(
        rubric="审题准确度15分，论证思维20分。",
        answer_minutes=3,
        passing_score=95,
    )
    prompts: list[str] = []

    class FakeResponse:
        def __init__(self, content: str):
            self.content = content

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": self.content}}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            self.responses = [
                FakeResponse(
                    '{"role_prompt":"你是一名考生","answer_principles":["自然作答"],'
                    '"dimensions":[{"name":"审题准确度","max_score":15,"pitfalls":["偏题"]}],'
                    '"retry_policy":["修复低分项"],"output_rules":["纯文本"]}'
                ),
                FakeResponse(
                    '{"role_prompt":"你是一名考生","answer_principles":["自然作答"],'
                    '"dimensions":[{"name":"审题准确度","max_score":15,'
                    '"criteria":["准确把握题目核心任务"],"pitfalls":["偏题"]}],'
                    '"retry_policy":["修复低分项"],"output_rules":["纯文本"]}'
                ),
            ]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            prompts.append(json["messages"][1]["content"])
            return self.responses.pop(0)

    monkeypatch.setattr(rubric_compiler.httpx, "AsyncClient", FakeAsyncClient)

    result = await _compile_with_openai(request, "test-key")

    assert result.rubric_schema.dimensions[0].criteria == ["准确把握题目核心任务"]
    assert len(prompts) == 2
    assert "修复" in prompts[1]


@pytest.mark.asyncio
async def test_compile_with_openai_uses_configured_timeout(monkeypatch):
    request = CompileRubricRequest(
        rubric="审题准确度15分，论证思维20分。",
        answer_minutes=3,
        passing_score=95,
    )
    captured_timeout = None

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"role_prompt":"你是一名考生","answer_principles":["自然作答"],'
                                '"dimensions":[{"name":"审题准确度","max_score":15,'
                                '"criteria":["准确把握题目核心任务"],"pitfalls":["偏题"]}],'
                                '"retry_policy":["修复低分项"],"output_rules":["纯文本"]}'
                            )
                        }
                    }
                ]
            }

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            nonlocal captured_timeout
            captured_timeout = kwargs.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers, json):
            return FakeResponse()

    monkeypatch.setenv("OPENAI_TIMEOUT_SECONDS", "180")
    monkeypatch.setattr(rubric_compiler.httpx, "AsyncClient", FakeAsyncClient)

    await _compile_with_openai(request, "test-key")

    assert captured_timeout == 180
