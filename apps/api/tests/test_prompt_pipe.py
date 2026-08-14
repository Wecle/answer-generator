import pytest
from pydantic import ValidationError

from app.models import GenerateAnswerRequest, RetryFeedback
from app.services.prompt_pipe import build_generation_prompt
from tests.rubric_fixtures import valid_schema_data


def make_request(**overrides):
    schema = valid_schema_data()
    schema["compilation"]["auditor_model"] = "test-model"
    schema["compilation"]["coverage_passed"] = True
    values = {
        "question": "请谈谈如何提升基层治理能力？",
        "rubric_schema": schema,
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
    assert result.prompt.count("措施形成闭环") == 1
    assert result.prompt.count("只表态不分析") == 1
    assert result.prompt.count("措施没有反馈") == 1
    assert "原始评分标准" not in result.prompt
    assert "任务核心提示词" not in result.prompt
    assert result.metadata.loaded_sections == [
        "base_role",
        "rubric_constraints",
        "question",
        "length",
        "output_rules",
    ]


def test_prompt_loads_only_present_optional_sections():
    result = build_generation_prompt(
        make_request(
            material="某地正在推进基层治理改革。",
            question="问题 1：分析原因。\n问题 2：提出措施。",
            previous_feedback=RetryFeedback(
                failed_criteria=[
                    {
                        "criterion_id": "CRI-001",
                        "reason": "原因单一",
                        "repair_instruction": "补充制度原因",
                    }
                ],
                preserved_criteria_ids=["CRI-002"],
            ),
        )
    )

    assert "material" in result.metadata.loaded_sections
    assert "multi_question" in result.metadata.loaded_sections
    assert "retry_feedback" in result.metadata.loaded_sections
    assert "补充制度原因" in result.prompt
    assert "420～620" in result.prompt


def test_prompt_omits_empty_optional_sections():
    result = build_generation_prompt(
        make_request(material="   ", previous_feedback=RetryFeedback())
    )

    assert "material" not in result.metadata.loaded_sections
    assert "multi_question" not in result.metadata.loaded_sections
    assert "retry_feedback" not in result.metadata.loaded_sections


def test_prompt_loads_reasons_only_feedback_and_numbered_questions():
    result = build_generation_prompt(
        make_request(
            question="1. 分析原因。\n2、提出措施。",
            previous_feedback=RetryFeedback(reasons=["需要增强论证的针对性"]),
        )
    )

    assert "multi_question" in result.metadata.loaded_sections
    assert "retry_feedback" in result.metadata.loaded_sections
    assert "需要增强论证的针对性" in result.prompt


def test_generation_request_rejects_unverified_schema_and_invalid_word_bounds():
    unverified = valid_schema_data()
    with pytest.raises(ValidationError):
        make_request(rubric_schema=unverified)

    with pytest.raises(ValidationError):
        make_request(target_min_words=600, target_words=520, target_max_words=620)

    with pytest.raises(ValidationError):
        make_request(rubric="legacy", compiled_prompt="legacy")
