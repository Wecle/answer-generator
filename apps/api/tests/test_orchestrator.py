import pytest

from app.models import ReviewAnswerRequest, RunItemRequest
from app.services.orchestrator import run_item
from app.services.reviewer import review_answer


@pytest.mark.asyncio
async def test_run_item_passes_within_attempt_limit():
    result = await run_item(
        RunItemRequest(
            material="材料：某地推进政务服务改革，群众办事效率明显提升。",
            question="请谈谈如何进一步提升政务服务质量？",
            rubric="审题准确、逻辑清晰、措施可行、群众需求、闭环管理",
            answer_minutes=2,
            target_words=520,
            passing_score=90,
            max_attempts=3,
        )
    )

    assert result.status == "passed"
    assert result.final_score >= 90
    assert len(result.attempts) >= 1
    assert [dimension.name for dimension in result.attempts[-1].review.dimensions] == ["审题准确、逻辑清晰、措施可行、群众需求、闭环管理"]


@pytest.mark.asyncio
async def test_reviewer_uses_user_rubric_dimensions_and_constructive_feedback():
    review = await review_answer(
        ReviewAnswerRequest(
            question="请谈谈如何提升基层治理能力。",
            rubric="#### 维度一：群众需求（满分50分）\n- 回应群众诉求\n- 建立反馈渠道\n\n#### 维度二：闭环管理（满分50分）\n- 明确责任主体\n- 跟踪整改效果",
            answer="要回应群众诉求，明确责任主体。",
            passing_score=95,
        )
    )

    assert [dimension.name for dimension in review.dimensions] == ["群众需求", "闭环管理"]
    assert review.total_score < 95
    assert any("反馈渠道" in reason for reason in review.reasons)
    assert any("跟踪整改效果" in reason for reason in review.reasons)


@pytest.mark.asyncio
async def test_generation_covers_user_rubric_terms():
    result = await run_item(
        RunItemRequest(
            question="请分析基层治理中的协同问题。",
            rubric="基层协同、责任闭环、群众参与、数字治理",
            answer_minutes=1,
            target_words=260,
            passing_score=95,
            max_attempts=2,
        )
    )

    assert result.status == "passed"
    assert "责任闭环" in result.final_answer
    assert "群众参与" in result.final_answer
    assert "数字治理" in result.final_answer


@pytest.mark.asyncio
async def test_run_item_generates_separate_plain_text_answers_for_multiple_questions():
    result = await run_item(
        RunItemRequest(
            material="材料 1\n某地窗口服务存在排队时间长的问题。\n\n材料 2\n某社区正在推进数字治理。",
            question="问题 1\n请谈谈如何提升窗口服务效率？\n\n问题 2\n请分析数字治理如何更好服务群众？",
            rubric="## 评分标准\n- 群众需求\n- 闭环管理\n- 数字治理",
            answer_minutes=1,
            target_words=260,
            passing_score=85,
            max_attempts=2,
        )
    )

    assert "第 1 题" in result.final_answer
    assert "第 2 题" in result.final_answer
    assert "参考答案：" not in result.final_answer
    assert "#" not in result.final_answer
    assert "**" not in result.final_answer
