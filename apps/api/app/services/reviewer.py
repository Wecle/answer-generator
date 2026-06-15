from app.models import ReviewAnswerRequest, ReviewAnswerResponse, ReviewDimension


DIMENSIONS = [
    ("审题与材料理解", 20),
    ("结构完整度", 20),
    ("要点覆盖", 25),
    ("论证深度", 20),
    ("表达质量", 15),
]


async def review_answer(request: ReviewAnswerRequest) -> ReviewAnswerResponse:
    score = _score_answer(request)
    reasons = _build_reasons(request, score)
    dimensions = _split_dimensions(score)

    return ReviewAnswerResponse(
        total_score=score,
        passed=score >= request.passing_score,
        dimensions=dimensions,
        reasons=reasons,
        reviewer_model="heuristic-reviewer-v1",
    )


def _score_answer(request: ReviewAnswerRequest) -> int:
    answer = request.answer
    rubric_keywords = _keywords(request.rubric)
    coverage = sum(1 for keyword in rubric_keywords if keyword in answer)
    coverage_ratio = coverage / max(len(rubric_keywords), 1)
    length_score = min(len(answer) / 900, 1)
    structure_score = sum(1 for marker in ("第一", "第二", "第三", "最后") if marker in answer) / 4
    material_bonus = 1 if not request.material or request.material[:12] in answer or "结合材料" in answer else 0.6

    raw = 64 + coverage_ratio * 16 + length_score * 8 + structure_score * 8 + material_bonus * 4
    return max(0, min(98, round(raw)))


def _build_reasons(request: ReviewAnswerRequest, score: int) -> list[str]:
    reasons: list[str] = []
    if score >= request.passing_score:
        return ["答案已达到评分标准，结构、要点和表达均满足要求。"]

    if len(request.answer) < 700:
        reasons.append("答案展开不足，需要补充论证和具体措施。")
    if "第一" not in request.answer or "第二" not in request.answer:
        reasons.append("结构层次需要更清晰。")

    missing = [keyword for keyword in _keywords(request.rubric) if keyword not in request.answer]
    if missing:
        reasons.append(f"评分关键词覆盖不足：{'、'.join(missing[:5])}。")

    return reasons or ["答案质量未达到通过线，需要提高针对性和完整度。"]


def _split_dimensions(total_score: int) -> list[ReviewDimension]:
    remaining = total_score
    dimensions: list[ReviewDimension] = []
    for index, (name, max_score) in enumerate(DIMENSIONS):
        if index == len(DIMENSIONS) - 1:
            score = min(max_score, remaining)
        else:
            score = round(total_score * max_score / 100)
            remaining -= score
        dimensions.append(ReviewDimension(name=name, score=score, max_score=max_score))
    return dimensions


def _keywords(rubric: str) -> list[str]:
    separators = ["，", "。", "；", ";", "、", "\n", " "]
    text = rubric
    for separator in separators:
        text = text.replace(separator, "|")
    keywords = [part.strip("：:.-") for part in text.split("|") if len(part.strip("：:.-")) >= 2]
    return keywords[:12]

