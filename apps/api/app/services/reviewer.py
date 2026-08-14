import json
import os
import re

import httpx

from app.models import (
    FailedCriterion,
    ReviewAnswerRequest,
    ReviewAnswerResponse,
    ReviewDimension,
)


async def review_answer(request: ReviewAnswerRequest) -> ReviewAnswerResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        try:
            return await _review_with_openai(request, api_key)
        except Exception:
            pass

    return _review_locally(request)


async def _review_with_openai(
    request: ReviewAnswerRequest, api_key: str
) -> ReviewAnswerResponse:
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    dimensions_payload = [
        {
            "dimension_id": dimension.id,
            "name": dimension.name,
            "max_score": dimension.max_score,
            "criteria": [
                {"criterion_id": item.id, "text": item.text}
                for item in dimension.criteria
            ],
            "pitfalls": [item.text for item in dimension.pitfalls],
        }
        for dimension in request.rubric_schema.dimensions
    ]
    prompt = (
        "你是公务员结构化面试答案评分员。只依据给定的 Rubric Schema 评分，只输出 JSON。\n"
        "评分原则：\n"
        "1. 按 dimension_id 对每个维度评分，分数必须在 0 到 max_score 之间。\n"
        "2. 依据 criterion 的语义满足度判断，不要求答案逐字复述。\n"
        "3. 未满足的 criterion 必须返回 criterion_id、具体原因和可执行修复指令。\n"
        "4. 已满足的 criterion_id 放入 preserved_criteria_ids，不得返回未知 ID。\n"
        "5. 若规则涉及语音表达而输入只有文字，请评估文字稿的口述可行性和自然表达潜力，"
        "不得因缺少音频直接给 0 分。\n"
        "6. 不得要求答案加入注释、批注、重音符号、语速标记、旁白或舞台提示。\n\n"
        f"通过分数：{request.passing_score}\n"
        f"材料：\n{request.material or '无材料'}\n\n"
        f"题目：\n{request.question}\n\n"
        "Rubric Schema 评分维度 JSON：\n"
        f"{json.dumps(dimensions_payload, ensure_ascii=False)}\n\n"
        f"答案：\n{request.answer}\n\n"
        "返回 JSON 格式："
        '{"dimensions":[{"dimension_id":"DIM-001","score":0}],'
        '"failed_criteria":[{"criterion_id":"CRI-001","reason":"具体缺失",'
        '"repair_instruction":"具体修复动作"}],'
        '"preserved_criteria_ids":["CRI-002"],'
        '"total_score":0,"passed":false,"reasons":["审核摘要"]}'
    )

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": "你是严格、稳定、可解释的公务员面试评分员。",
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()

    data = json.loads(payload["choices"][0]["message"]["content"])
    dimensions = _normalize_ai_dimensions(data.get("dimensions"), request)
    total_score = min(100, sum(item.score for item in dimensions))
    failed_criteria = _normalize_failed_criteria(
        data.get("failed_criteria"), request
    )
    failed_ids = {item.criterion_id for item in failed_criteria}
    preserved = [
        item
        for item in _normalize_preserved_criteria(
            data.get("preserved_criteria_ids"), request
        )
        if item not in failed_ids
    ]
    known_criteria_ids = _known_criteria_ids(request)
    if failed_ids | set(preserved) != known_criteria_ids:
        raise ValueError("AI review must classify every known criterion exactly once")
    reasons = _normalize_reasons(data.get("reasons"))
    if not reasons:
        reasons = _summary_reasons(
            total_score, request.passing_score, failed_criteria
        )

    return ReviewAnswerResponse(
        total_score=total_score,
        passed=total_score >= request.passing_score,
        dimensions=dimensions,
        failed_criteria=failed_criteria,
        preserved_criteria_ids=preserved,
        reasons=reasons,
        reviewer_model=model,
    )


def _review_locally(request: ReviewAnswerRequest) -> ReviewAnswerResponse:
    dimensions: list[ReviewDimension] = []
    failed_criteria: list[FailedCriterion] = []
    preserved: list[str] = []

    for dimension in request.rubric_schema.dimensions:
        hits = 0
        for criterion in dimension.criteria:
            if _keyword_hit(request.answer, criterion.text):
                hits += 1
                preserved.append(criterion.id)
            else:
                failed_criteria.append(
                    FailedCriterion(
                        criterion_id=criterion.id,
                        reason=f"答案未充分覆盖：{criterion.text}",
                        repair_instruction=f"补充并具体说明：{criterion.text}",
                    )
                )
        score = round(dimension.max_score * hits / len(dimension.criteria))
        dimensions.append(
            ReviewDimension(
                dimension_id=dimension.id,
                name=dimension.name,
                score=score,
                max_score=dimension.max_score,
            )
        )

    total_score = min(100, sum(item.score for item in dimensions))
    return ReviewAnswerResponse(
        total_score=total_score,
        passed=total_score >= request.passing_score,
        dimensions=dimensions,
        failed_criteria=failed_criteria,
        preserved_criteria_ids=preserved,
        reasons=_summary_reasons(
            total_score, request.passing_score, failed_criteria
        ),
        reviewer_model="schema-criterion-reviewer-v1",
    )


def _normalize_ai_dimensions(
    value: object, request: ReviewAnswerRequest
) -> list[ReviewDimension]:
    raw_dimensions = value if isinstance(value, list) else []
    scores: dict[str, int] = {}
    for item in raw_dimensions:
        if not isinstance(item, dict):
            continue
        dimension_id = str(item.get("dimension_id", "")).strip()
        try:
            scores[dimension_id] = int(round(float(item.get("score", 0))))
        except (TypeError, ValueError, OverflowError):
            scores[dimension_id] = 0

    return [
        ReviewDimension(
            dimension_id=dimension.id,
            name=dimension.name,
            score=max(0, min(dimension.max_score, scores.get(dimension.id, 0))),
            max_score=dimension.max_score,
        )
        for dimension in request.rubric_schema.dimensions
    ]


def _normalize_failed_criteria(
    value: object, request: ReviewAnswerRequest
) -> list[FailedCriterion]:
    known_ids = _known_criteria_ids(request)
    raw_items = value if isinstance(value, list) else []
    normalized: list[FailedCriterion] = []
    seen: set[str] = set()
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        criterion_id_value = item.get("criterion_id")
        reason_value = item.get("reason")
        repair_value = item.get("repair_instruction")
        if (
            not isinstance(criterion_id_value, str)
            or not isinstance(reason_value, str)
            or not isinstance(repair_value, str)
        ):
            continue
        criterion_id = criterion_id_value.strip()
        reason = reason_value.strip()
        repair_instruction = repair_value.strip()
        if (
            criterion_id not in known_ids
            or criterion_id in seen
            or not reason
            or not repair_instruction
        ):
            continue
        normalized.append(
            FailedCriterion(
                criterion_id=criterion_id,
                reason=reason,
                repair_instruction=repair_instruction,
            )
        )
        seen.add(criterion_id)
    return normalized


def _normalize_preserved_criteria(
    value: object, request: ReviewAnswerRequest
) -> list[str]:
    known_ids = _known_criteria_ids(request)
    raw_items = value if isinstance(value, list) else []
    return _unique(
        item.strip()
        for item in raw_items
        if isinstance(item, str) and item.strip() in known_ids
    )


def _normalize_reasons(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [
        item.strip()
        for item in value
        if isinstance(item, str) and item.strip()
    ][:6]


def _known_criteria_ids(request: ReviewAnswerRequest) -> set[str]:
    return {
        criterion.id
        for dimension in request.rubric_schema.dimensions
        for criterion in dimension.criteria
    }


def _summary_reasons(
    score: int,
    passing_score: int,
    failed_criteria: list[FailedCriterion],
) -> list[str]:
    if score >= passing_score:
        return ["答案已达到当前评分标准。"]
    reasons = [item.reason for item in failed_criteria[:5]]
    reasons.append(
        f"当前得分 {score}，距离通过线还差 {passing_score - score} 分；"
        "下一轮只修复未满足的评分项并保留已满足内容。"
    )
    return reasons


def _keyword_hit(answer: str, criterion_text: str) -> bool:
    if criterion_text in answer:
        return True
    fragments = [part for part in _split_text(criterion_text) if len(part) >= 2]
    if not fragments:
        return False
    hits = sum(1 for fragment in fragments if fragment in answer)
    return hits / len(fragments) >= 0.5


def _split_text(text: str) -> list[str]:
    return [
        part.strip()
        for part in re.split(r"[，,。；;、\n\r\s/]+", text)
        if part.strip()
    ]


def _unique(values) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
