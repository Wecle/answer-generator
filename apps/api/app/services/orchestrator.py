from app.models import (
    GenerateAnswerRequest,
    ReviewAnswerRequest,
    RunAttempt,
    RunItemRequest,
    RunItemResponse,
)
from app.services.generator import generate_answer
from app.services.reviewer import review_answer


async def run_item(request: RunItemRequest) -> RunItemResponse:
    attempts: list[RunAttempt] = []
    feedback: list[str] = []
    final_answer = ""
    final_score = 0
    reasons: list[str] = []

    for attempt_number in range(1, request.max_attempts + 1):
        generated = await generate_answer(
            GenerateAnswerRequest(
                material=request.material,
                question=request.question,
                rubric=request.rubric,
                compiled_prompt=request.compiled_prompt,
                rubric_schema=request.rubric_schema,
                answer_minutes=request.answer_minutes,
                target_words=request.target_words,
                previous_feedback=feedback,
            )
        )
        review = await review_answer(
            ReviewAnswerRequest(
                material=request.material,
                question=request.question,
                rubric=request.rubric,
                rubric_schema=request.rubric_schema,
                answer=generated.answer,
                passing_score=request.passing_score,
            )
        )

        attempts.append(RunAttempt(attempt_number=attempt_number, answer=generated.answer, review=review))
        final_answer = generated.answer
        final_score = review.total_score
        reasons = review.reasons

        if review.passed:
            return RunItemResponse(
                status="passed",
                attempts=attempts,
                final_answer=final_answer,
                final_score=final_score,
                reasons=reasons,
            )

        feedback = review.reasons

    return RunItemResponse(
        status="needs_review",
        attempts=attempts,
        final_answer=final_answer,
        final_score=final_score,
        reasons=reasons,
    )
