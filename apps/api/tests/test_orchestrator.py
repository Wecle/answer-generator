import pytest

from app.models import RunItemRequest
from app.services.orchestrator import run_item


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


@pytest.mark.asyncio
async def test_run_item_marks_manual_review_at_retry_cap():
    result = await run_item(
        RunItemRequest(
            question="请分析基层治理中的协同问题。",
            rubric="必须出现一个罕见关键词XYZ",
            answer_minutes=1,
            target_words=260,
            passing_score=99,
            max_attempts=2,
        )
    )

    assert result.status == "needs_review"
    assert len(result.attempts) == 2

