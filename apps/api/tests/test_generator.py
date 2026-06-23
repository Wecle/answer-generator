import pytest

from app.models import GenerateAnswerRequest
from app.services.generator import _build_prompt, generate_answer


def test_prompt_asks_model_to_choose_interview_structure_without_exposing_reasoning():
    prompt = _build_prompt(
        GenerateAnswerRequest(
            question="单位要组织一次基层调研，你会怎么开展？",
            rubric="目标明确、计划周密、沟通协调、总结反馈",
            answer_minutes=3,
            target_words=700,
        )
    )

    assert "内部判断本题主要考察的作答任务和测评要素" in prompt
    assert "常见作答任务包括但不限于" in prompt
    assert "不要机械套用固定模板" in prompt
    assert "不要在答案中出现“评分标准”“审核意见”“必须覆盖”等系统用语" in prompt


@pytest.mark.asyncio
async def test_generate_answer_requires_ai_configuration(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        await generate_answer(
            GenerateAnswerRequest(
                question="请谈谈如何提升窗口服务效率？",
                rubric="群众需求、流程优化、数字治理、闭环管理",
                answer_minutes=2,
                target_words=500,
            )
        )


def test_prompt_forbids_annotation_and_stage_direction_output():
    prompt = _build_prompt(
        GenerateAnswerRequest(
            question="请谈谈如何提升基层治理能力。",
            rubric="审题准确、论证清晰、语言自然",
            answer_minutes=3,
            target_words=700,
            previous_feedback=["下一轮需标注停顿（//）、重音（·）和语速变化"],
        )
    )

    assert "不得输出 // 注释" in prompt
    assert "不得输出舞台提示" in prompt
    assert "只能转化为自然口述表达" in prompt
