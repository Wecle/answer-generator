import pytest

from app.models import (
    FailedCriterion,
    GenerateAnswerResponse,
    PromptMetadata,
    ReviewAnswerResponse,
    ReviewDimension,
    ReviewScoringDetails,
    RubricSchemaV2,
    RunItemRequest,
)
import app.services.orchestrator as orchestrator
from app.services.orchestrator import run_item
from tests.rubric_fixtures import valid_schema_data


def verified_schema() -> RubricSchemaV2:
    data = valid_schema_data()
    data["compilation"].update({"auditor_model": "test-auditor", "coverage_passed": True})
    return RubricSchemaV2.model_validate(data)


def generated_response(answer: str) -> GenerateAnswerResponse:
    return GenerateAnswerResponse(
        answer=answer,
        model="test-ai",
        prompt_metadata=PromptMetadata(
            loaded_sections=["base_role", "rubric_constraints", "question", "length", "output_rules"]
        ),
    )


def review_response(*, score: int, passed: bool) -> ReviewAnswerResponse:
    return ReviewAnswerResponse(
        total_score=score,
        passed=passed,
        dimensions=[
            ReviewDimension(
                dimension_id="DIM-001",
                name="综合分析",
                score=min(score, 50),
                max_score=50,
            ),
            ReviewDimension(
                dimension_id="DIM-002",
                name="解决问题",
                score=max(0, score - 50),
                max_score=50,
            ),
        ],
        scoring_details=ReviewScoringDetails(
            base_score=score,
            raw_score=score,
            normalized_score=score,
            final_score=score,
        ),
        failed_criteria=[] if passed else [
            FailedCriterion(
                criterion_id="CRI-002",
                reason="缺少闭环",
                repair_instruction="补充反馈整改",
            )
        ],
        preserved_criteria_ids=["CRI-001", "CRI-002"] if passed else ["CRI-001"],
        reasons=["已通过"] if passed else ["需要形成闭环"],
        reviewer_model="test-ai",
    )


@pytest.mark.asyncio
async def test_run_item_passes_within_attempt_limit(monkeypatch):
    async def fake_generate_answer(_request):
        return generated_response("审题准确，逻辑清晰，措施可行，回应群众需求，建立闭环管理。")

    async def fake_review_answer(_request):
        return review_response(score=95, passed=True)

    monkeypatch.setattr(orchestrator, "generate_answer", fake_generate_answer)
    monkeypatch.setattr(orchestrator, "review_answer", fake_review_answer)

    result = await run_item(
        RunItemRequest(
            material="材料：某地推进政务服务改革，群众办事效率明显提升。",
            question="请谈谈如何进一步提升政务服务质量？",
            rubric_schema=verified_schema(),
            answer_minutes=2,
            target_min_words=420,
            target_words=520,
            target_max_words=620,
            passing_score=90,
            max_attempts=3,
        )
    )

    assert result.status == "passed"
    assert result.final_score == 95
    assert len(result.attempts) == 1
    assert result.attempts[0].review.dimensions[0].dimension_id == "DIM-001"


@pytest.mark.asyncio
async def test_run_item_passes_structured_review_feedback_to_retry(monkeypatch):
    generation_requests = []
    review_calls = 0

    async def fake_generate_answer(request):
        generation_requests.append(request)
        return generated_response(f"第 {len(generation_requests)} 次答案")

    async def fake_review_answer(_request):
        nonlocal review_calls
        review_calls += 1
        if review_calls == 1:
            return review_response(score=80, passed=False)
        return review_response(score=96, passed=True)

    monkeypatch.setattr(orchestrator, "generate_answer", fake_generate_answer)
    monkeypatch.setattr(orchestrator, "review_answer", fake_review_answer)

    result = await run_item(
        RunItemRequest(
            question="请分析基层治理中的协同问题。",
            rubric_schema=verified_schema(),
            answer_minutes=1,
            target_min_words=220,
            target_words=260,
            target_max_words=300,
            passing_score=95,
            max_attempts=2,
        )
    )

    assert result.status == "passed"
    assert len(generation_requests) == 2
    assert generation_requests[0].previous_feedback is None
    feedback = generation_requests[1].previous_feedback
    assert feedback is not None
    assert feedback.failed_criteria[0].criterion_id == "CRI-002"
    assert feedback.failed_criteria[0].repair_instruction == "补充反馈整改"
    assert feedback.preserved_criteria_ids == ["CRI-001"]
    assert feedback.reasons == ["需要形成闭环"]


@pytest.mark.asyncio
async def test_run_item_forwards_all_word_bounds_and_schema_only(monkeypatch):
    captured = None

    async def fake_generate_answer(request):
        nonlocal captured
        captured = request
        return generated_response("答案")

    async def fake_review_answer(_request):
        return review_response(score=95, passed=True)

    monkeypatch.setattr(orchestrator, "generate_answer", fake_generate_answer)
    monkeypatch.setattr(orchestrator, "review_answer", fake_review_answer)

    await run_item(
        RunItemRequest(
            question="问题",
            rubric_schema=verified_schema(),
            answer_minutes=2,
            target_min_words=420,
            target_words=520,
            target_max_words=620,
        )
    )

    assert captured is not None
    assert captured.target_min_words == 420
    assert captured.target_words == 520
    assert captured.target_max_words == 620
    assert captured.rubric_schema.version == "v2"
    assert not hasattr(captured, "rubric")
    assert not hasattr(captured, "compiled_prompt")


@pytest.mark.asyncio
async def test_run_item_returns_last_attempt_when_limit_is_reached(monkeypatch):
    async def fake_generate_answer(_request):
        return generated_response("尚需完善的答案")

    async def fake_review_answer(_request):
        return review_response(score=80, passed=False)

    monkeypatch.setattr(orchestrator, "generate_answer", fake_generate_answer)
    monkeypatch.setattr(orchestrator, "review_answer", fake_review_answer)

    result = await run_item(
        RunItemRequest(
            question="问题",
            rubric_schema=verified_schema(),
            answer_minutes=1,
            target_min_words=220,
            target_words=260,
            target_max_words=300,
            max_attempts=2,
        )
    )

    assert result.status == "needs_review"
    assert len(result.attempts) == 2
    assert result.reasons == ["需要形成闭环"]
