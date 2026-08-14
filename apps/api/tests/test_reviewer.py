import json

import pytest
from pydantic import ValidationError

from app.models import ReviewAnswerRequest
from app.services.reviewer import review_answer
import app.services.reviewer as reviewer
from tests.rubric_fixtures import valid_schema_data


def verified_schema_data() -> dict:
    schema = valid_schema_data()
    schema["compilation"]["auditor_model"] = "test-auditor"
    schema["compilation"]["coverage_passed"] = True
    return schema


def make_review_request() -> ReviewAnswerRequest:
    return ReviewAnswerRequest(
        question="如何形成工作闭环？",
        rubric_schema=verified_schema_data(),
        answer="要准确分析问题并提出措施。",
        passing_score=95,
    )


def install_review_completion(monkeypatch, payload: dict) -> None:
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(payload, ensure_ascii=False)
                        }
                    }
                ]
            }

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
    result = await review_answer(
        ReviewAnswerRequest(
            question="如何形成工作闭环？",
            rubric_schema=verified_schema_data(),
            answer="要准确分析问题。",
            passing_score=95,
        )
    )

    assert result.total_score == sum(item.score for item in result.dimensions)
    assert any(item.criterion_id == "CRI-002" for item in result.failed_criteria)
    assert "CRI-001" in result.preserved_criteria_ids


@pytest.mark.asyncio
async def test_reviewer_rejects_model_total_and_unknown_criteria(monkeypatch):
    install_review_completion(
        monkeypatch,
        {
            "dimensions": [
                {"dimension_id": "DIM-001", "score": 45},
                {"dimension_id": "DIM-002", "score": 35},
            ],
            "failed_criteria": [
                {
                    "criterion_id": "CRI-002",
                    "reason": "缺少闭环",
                    "repair_instruction": "补充反馈整改",
                },
                {
                    "criterion_id": "CRI-999",
                    "reason": "未知",
                    "repair_instruction": "忽略",
                },
            ],
            "preserved_criteria_ids": ["CRI-001", "CRI-999"],
            "total_score": 100,
            "passed": True,
            "reasons": ["需要形成闭环"],
        },
    )

    result = await review_answer(make_review_request())

    assert result.total_score == 80
    assert result.passed is False
    assert [item.criterion_id for item in result.failed_criteria] == ["CRI-002"]
    assert result.preserved_criteria_ids == ["CRI-001"]


@pytest.mark.asyncio
async def test_reviewer_falls_back_when_ai_criterion_classification_is_incomplete(
    monkeypatch,
):
    install_review_completion(
        monkeypatch,
        {
            "dimensions": [
                {"dimension_id": "DIM-001", "score": 45},
                {"dimension_id": "DIM-002", "score": 10},
            ],
            "failed_criteria": [],
            "preserved_criteria_ids": ["CRI-001"],
            "reasons": [{"invalid": "not a string"}],
        },
    )

    result = await review_answer(make_review_request())

    assert result.reviewer_model == "schema-criterion-reviewer-v1"
    assert [item.criterion_id for item in result.failed_criteria] == ["CRI-002"]
    assert result.preserved_criteria_ids == ["CRI-001"]
    assert all("invalid" not in reason for reason in result.reasons)


@pytest.mark.asyncio
async def test_reviewer_clamps_ai_dimension_scores(monkeypatch):
    install_review_completion(
        monkeypatch,
        {
            "dimensions": [
                {"dimension_id": "DIM-001", "score": 999},
                {"dimension_id": "DIM-002", "score": -5},
            ],
            "failed_criteria": [
                {
                    "criterion_id": "CRI-002",
                    "reason": "缺少闭环",
                    "repair_instruction": "补充反馈整改",
                }
            ],
            "preserved_criteria_ids": ["CRI-001"],
            "reasons": ["需要形成闭环"],
        },
    )

    result = await review_answer(make_review_request())

    assert [item.score for item in result.dimensions] == [50, 0]
    assert result.total_score == 50
    assert result.passed is False


def test_review_request_rejects_unverified_schema_and_legacy_rubric():
    with pytest.raises(ValidationError):
        ReviewAnswerRequest(
            question="问题",
            rubric_schema=valid_schema_data(),
            answer="答案",
        )

    with pytest.raises(ValidationError):
        ReviewAnswerRequest(
            question="问题",
            rubric_schema=verified_schema_data(),
            rubric="legacy",
            answer="答案",
        )
