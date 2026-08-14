import json
from typing import Optional

import pytest
from pydantic import ValidationError

from app.models import ReviewAnswerRequest
from app.services.reviewer import review_answer
import app.services.reviewer as reviewer
from tests.rubric_fixtures import normalized_schema_data, valid_schema_data


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


def make_normalized_review_request(**overrides) -> ReviewAnswerRequest:
    schema = normalized_schema_data()
    schema["compilation"]["auditor_model"] = "test-auditor"
    schema["compilation"]["coverage_passed"] = True
    values = {
        "question": "如何形成工作闭环？",
        "rubric_schema": schema,
        "answer": "要准确分析问题并提出措施。",
        "passing_score": 95,
    }
    values.update(overrides)
    return ReviewAnswerRequest(**values)


def install_review_completion(
    monkeypatch, payload: dict, captured_request: Optional[dict] = None
) -> None:
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
            if captured_request is not None:
                captured_request.update(json)
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
    assert result.scoring_details.final_score == result.total_score
    assert result.scoring_details.awarded_bonuses == []
    assert result.scoring_details.triggered_penalties == []
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
    assert result.scoring_details.final_score == 80
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


@pytest.mark.asyncio
async def test_reviewer_normalizes_known_bonus_and_penalty_ids(monkeypatch):
    captured_request: dict = {}
    install_review_completion(
        monkeypatch,
        {
            "dimensions": [
                {"dimension_id": "DIM-001", "score": 40},
                {"dimension_id": "DIM-002", "score": 30},
            ],
            "bonuses": [
                {
                    "bonus_rule_id": "BONUS-001",
                    "score": 4,
                    "reason": "表达有具体场景",
                },
                {
                    "bonus_rule_id": "BONUS-002",
                    "score": 3,
                    "reason": "表达自然",
                },
                {
                    "bonus_rule_id": "BONUS-999",
                    "score": 99,
                    "reason": "未知规则",
                },
            ],
            "triggered_penalties": [
                {"penalty_rule_id": "PEN-999", "reason": "未知规则"}
            ],
            "failed_criteria": [],
            "preserved_criteria_ids": ["CRI-001", "CRI-002"],
            "total_score": 1,
            "passed": True,
            "reasons": ["模型声明的总分不能被信任"],
        },
        captured_request,
    )

    result = await review_answer(make_normalized_review_request())

    assert result.total_score == 94
    assert result.passed is False
    assert result.scoring_details.raw_score == 77
    assert result.scoring_details.normalized_score == 94
    assert [item.model_dump() for item in result.scoring_details.awarded_bonuses] == [
        {
            "bonus_rule_id": "BONUS-001",
            "score": 4,
            "reason": "表达有具体场景",
        },
        {"bonus_rule_id": "BONUS-002", "score": 3, "reason": "表达自然"},
    ]
    assert result.scoring_details.triggered_penalties == []
    prompt = captured_request["messages"][1]["content"]
    assert '"scoring_policy"' in prompt
    assert '"bonuses"' in prompt
    assert '"triggered_penalties"' in prompt


@pytest.mark.asyncio
async def test_triggered_veto_fails_regardless_of_final_score(monkeypatch):
    request = make_normalized_review_request(passing_score=1)
    request.rubric_schema.scoring_policy.penalty_rules[1].effect = "veto"
    install_review_completion(
        monkeypatch,
        {
            "dimensions": [
                {"dimension_id": "DIM-001", "score": 40},
                {"dimension_id": "DIM-002", "score": 35},
            ],
            "bonuses": [
                {"bonus_rule_id": "BONUS-001", "score": 4, "reason": "有画面"},
                {"bonus_rule_id": "BONUS-002", "score": 3, "reason": "有人味"},
            ],
            "triggered_penalties": [
                {"penalty_rule_id": "PEN-002", "reason": "触发否决"}
            ],
            "failed_criteria": [],
            "preserved_criteria_ids": ["CRI-001", "CRI-002"],
            "total_score": 100,
            "passed": True,
            "reasons": [],
        },
    )

    result = await review_answer(request)

    assert result.total_score == 100
    assert result.scoring_details.vetoed is True
    assert result.passed is False


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_score", [4.49, True, "4"])
async def test_reviewer_rejects_non_integer_bonus_scores(
    monkeypatch, invalid_score
):
    request = make_normalized_review_request()
    request.rubric_schema.scoring_policy.bonus_rules[0].min_score = 1
    install_review_completion(
        monkeypatch,
        {
            "dimensions": [
                {"dimension_id": "DIM-001", "score": 40},
                {"dimension_id": "DIM-002", "score": 30},
            ],
            "bonuses": [
                {
                    "bonus_rule_id": "BONUS-001",
                    "score": invalid_score,
                    "reason": "模型返回了非法分数类型",
                }
            ],
            "triggered_penalties": [],
            "failed_criteria": [],
            "preserved_criteria_ids": ["CRI-001", "CRI-002"],
            "reasons": [],
        },
    )

    result = await review_answer(request)

    assert result.scoring_details.awarded_bonuses[0].score == 0
    assert result.scoring_details.raw_score == 70
    assert result.total_score == 85


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_reason", [None, "", "   ", {"text": "伪依据"}])
async def test_reviewer_requires_reason_to_trigger_penalty(
    monkeypatch, invalid_reason
):
    request = make_normalized_review_request(passing_score=1)
    request.rubric_schema.scoring_policy.penalty_rules[1].effect = "veto"
    install_review_completion(
        monkeypatch,
        {
            "dimensions": [
                {"dimension_id": "DIM-001", "score": 40},
                {"dimension_id": "DIM-002", "score": 35},
            ],
            "bonuses": [],
            "triggered_penalties": [
                {"penalty_rule_id": "PEN-002", "reason": invalid_reason}
            ],
            "failed_criteria": [],
            "preserved_criteria_ids": ["CRI-001", "CRI-002"],
            "reasons": [],
        },
    )

    result = await review_answer(request)

    assert result.scoring_details.triggered_penalties == []
    assert result.scoring_details.vetoed is False
    assert result.passed is True


@pytest.mark.asyncio
async def test_local_reviewer_does_not_infer_subjective_rules(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    result = await review_answer(make_normalized_review_request())

    assert [
        (item.bonus_rule_id, item.score)
        for item in result.scoring_details.awarded_bonuses
    ] == [("BONUS-001", 0), ("BONUS-002", 0)]
    assert all(item.score == 0 for item in result.scoring_details.awarded_bonuses)
    assert result.scoring_details.triggered_penalties == []
    assert any("本地审核" in reason and "不推断" in reason for reason in result.reasons)


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
