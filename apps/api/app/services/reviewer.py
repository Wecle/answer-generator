import json
import os
import re
from dataclasses import dataclass
from typing import Optional

import httpx

from app.models import ReviewAnswerRequest, ReviewAnswerResponse, ReviewDimension


GENERIC_TERMS = {
    "评分标准",
    "评分细则",
    "满分",
    "总分",
    "适用于",
    "采用",
    "统一权重",
    "结构化面试",
    "无材料",
    "本评分",
    "考察维度",
    "包括",
    "不因题型而调整",
}


@dataclass
class RubricDimension:
    name: str
    max_score: int
    criteria: list[str]


async def review_answer(request: ReviewAnswerRequest) -> ReviewAnswerResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        try:
            return await _review_with_openai(request, api_key)
        except Exception:
            pass

    dimensions = _score_dimensions(request)
    total_score = min(100, sum(dimension.score for dimension in dimensions))
    reasons = _build_reasons(request, dimensions, total_score)

    return ReviewAnswerResponse(
        total_score=total_score,
        passed=total_score >= request.passing_score,
        dimensions=dimensions,
        reasons=reasons,
        reviewer_model="rubric-weighted-reviewer-v2",
    )


async def _review_with_openai(request: ReviewAnswerRequest, api_key: str) -> ReviewAnswerResponse:
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    rubric_dimensions = parse_rubric_dimensions(request.rubric, request.rubric_schema)
    dimensions_payload = [
        {
            "name": dimension.name,
            "max_score": dimension.max_score,
            "criteria": dimension.criteria,
        }
        for dimension in rubric_dimensions
    ]
    prompt = (
        "你是公务员结构化面试答案评分员。请严格按照用户给出的评分维度逐项评分，只输出 JSON。\n"
        "评分原则：\n"
        "1. 每个维度只能依据该维度 criteria 打分，不新增评分维度。\n"
        "2. 评分依据语义满足度，不要求答案逐字复述 criteria。\n"
        "3. 分数必须在 0 到该维度 max_score 之间。\n"
        "4. reasons 必须指出低分维度缺少什么、下一轮具体怎么补，避免空泛。\n"
        "5. 如果评分标准涉及语音表达，但输入只有文字答案，请评估文字稿的口述可行性、语句流畅度、节奏提示、时间控制和自然表达潜力；"
        "不得因为没有音频直接给 0 分。\n"
        "6. reasons 不得要求在答案正文中加入 // 注释、括号批注、重音符号、语速标记、旁白说明或舞台提示；"
        "相关问题只能表述为自然口述、语言节奏和表达流畅度建议。\n\n"
        f"通过分数：{request.passing_score}\n"
        f"材料：\n{request.material or '无材料'}\n\n"
        f"题目：\n{request.question}\n\n"
        f"评分维度 JSON：\n{json.dumps(dimensions_payload, ensure_ascii=False)}\n\n"
        f"答案：\n{request.answer}\n\n"
        "返回 JSON 格式："
        '{"dimensions":[{"name":"维度名","score":0,"max_score":10}],'
        '"total_score":0,"passed":false,"reasons":["具体重试意见"]}'
    )

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是严格、稳定、可解释的公务员面试评分员。"},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()

    data = json.loads(payload["choices"][0]["message"]["content"])
    dimensions = _normalize_ai_dimensions(data.get("dimensions"), rubric_dimensions)
    total_score = min(100, sum(dimension.score for dimension in dimensions))
    reasons = _normalize_reasons(data.get("reasons"), request, dimensions, total_score)
    return ReviewAnswerResponse(
        total_score=total_score,
        passed=total_score >= request.passing_score,
        dimensions=dimensions,
        reasons=reasons,
        reviewer_model=model,
    )


def _score_dimensions(request: ReviewAnswerRequest) -> list[ReviewDimension]:
    rubric_dimensions = parse_rubric_dimensions(request.rubric, request.rubric_schema)
    dimensions: list[ReviewDimension] = []

    for dimension in rubric_dimensions:
        keywords = _unique(_extract_keywords(dimension.name) + _extract_keywords("；".join(dimension.criteria)))
        coverage = _coverage_ratio(request.answer, keywords)
        dimensions.append(
            ReviewDimension(
                name=dimension.name,
                score=round(dimension.max_score * coverage),
                max_score=dimension.max_score,
            )
        )

    return dimensions


def _build_reasons(request: ReviewAnswerRequest, dimensions: list[ReviewDimension], score: int) -> list[str]:
    if score >= request.passing_score:
        return ["答案已达到当前评分标准。"]

    reasons: list[str] = []
    rubric_dimensions = parse_rubric_dimensions(request.rubric, request.rubric_schema)
    weak_dimensions = sorted(dimensions, key=lambda item: item.score / max(item.max_score, 1))[:3]

    for weak in weak_dimensions:
        rubric_dimension = next((item for item in rubric_dimensions if item.name == weak.name), None)
        if not rubric_dimension:
            continue

        keywords = _unique(_extract_keywords(weak.name) + _extract_keywords("；".join(rubric_dimension.criteria)))
        missing = [keyword for keyword in keywords if not _keyword_hit(request.answer, keyword)]
        if missing:
            reasons.append(
                f"{weak.name}得分 {weak.score}/{weak.max_score}，下一轮必须补充：{'、'.join(missing[:6])}；"
                "需要把对应要点写成可执行分析或对策，避免只复述题目。"
            )

    gap = max(request.passing_score - score, 0)
    reasons.append(f"当前得分 {score}，距离通过线还差 {gap} 分，下一轮只围绕用户评分标准中的低分项逐项补齐。")
    return reasons


def parse_rubric_dimensions(rubric: str, rubric_schema=None) -> list[RubricDimension]:
    if rubric_schema and rubric_schema.dimensions:
        return [
            RubricDimension(
                name=dimension.name,
                max_score=dimension.max_score,
                criteria=dimension.criteria or [dimension.name],
            )
            for dimension in rubric_schema.dimensions
        ]

    lines = [_clean_rubric_line(line) for line in rubric.splitlines()]
    lines = [line for line in lines if line]
    dimensions: list[RubricDimension] = []
    current_name = ""
    current_score: int | None = None
    current_criteria: list[str] = []

    def flush() -> None:
        nonlocal current_name, current_score, current_criteria
        if current_name:
            dimensions.append(
                RubricDimension(
                    name=_compact_dimension_name(current_name),
                    max_score=current_score or 0,
                    criteria=current_criteria or [current_name],
                )
            )
        current_name = ""
        current_score = None
        current_criteria = []

    for line in lines:
        score = _extract_score(line)
        looks_like_dimension = score is not None and ("维度" in line or "分" in line or "：" in line or ":" in line)
        if looks_like_dimension:
            flush()
            current_name = line
            current_score = score
            continue

        if current_name:
            current_criteria.append(line)
        elif len(line) <= 28:
            current_name = line
            current_criteria = [line]
        else:
            current_criteria.append(line)

    flush()

    if not dimensions:
        keywords = _extract_keywords(_plain_rubric_text(rubric))
        return [RubricDimension(name="用户评分标准", max_score=100, criteria=keywords or [_plain_rubric_text(rubric)])]

    known_score = sum(dimension.max_score for dimension in dimensions)
    if known_score <= 0:
        equal = max(1, round(100 / len(dimensions)))
        return [
            RubricDimension(name=dimension.name, max_score=equal, criteria=dimension.criteria)
            for dimension in dimensions
        ]

    if known_score != 100:
        return [
            RubricDimension(
                name=dimension.name,
                max_score=round(dimension.max_score / known_score * 100),
                criteria=dimension.criteria,
            )
            for dimension in dimensions
        ]

    return dimensions


def _normalize_ai_dimensions(value, rubric_dimensions: list[RubricDimension]) -> list[ReviewDimension]:
    ai_dimensions = value if isinstance(value, list) else []
    normalized: list[ReviewDimension] = []

    for rubric_dimension in rubric_dimensions:
        raw = next(
            (
                item
                for item in ai_dimensions
                if isinstance(item, dict) and str(item.get("name", "")).strip() == rubric_dimension.name
            ),
            None,
        )
        score = raw.get("score", 0) if raw else 0
        try:
            numeric_score = int(round(float(score)))
        except (TypeError, ValueError):
            numeric_score = 0

        normalized.append(
            ReviewDimension(
                name=rubric_dimension.name,
                score=max(0, min(rubric_dimension.max_score, numeric_score)),
                max_score=rubric_dimension.max_score,
            )
        )

    return normalized


def _normalize_reasons(value, request: ReviewAnswerRequest, dimensions: list[ReviewDimension], score: int) -> list[str]:
    reasons = [str(item).strip() for item in value if str(item).strip()] if isinstance(value, list) else []
    if reasons:
        return reasons[:6]
    return _build_reasons(request, dimensions, score)


def _clean_rubric_line(line: str) -> str:
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s*", "", line.strip())
    cleaned = re.sub(r"^\s*[-*+]\s+", "", cleaned)
    cleaned = re.sub(r"^\s*\d+[.)、]\s+", "", cleaned)
    cleaned = re.sub(r"\*\*(.*?)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"__(.*?)__", r"\1", cleaned)
    cleaned = cleaned.replace("`", "").strip()
    return cleaned


def _compact_dimension_name(line: str) -> str:
    name = re.sub(r"[（(]?\s*(满分)?\s*\d+\s*分\s*[)）]?", "", line)
    name = re.sub(r"^维度[一二三四五六七八九十\d]+[：:、\s]*", "", name)
    return name.strip("：: -")[:28] or "评分标准匹配度"


def _extract_score(line: str) -> Optional[int]:
    match = re.search(r"(?:满分)?\s*(\d{1,3})\s*分", line)
    if not match:
        return None
    score = int(match.group(1))
    return score if 0 < score <= 100 else None


def _coverage_ratio(answer: str, keywords: list[str]) -> float:
    if not keywords:
        return 1
    hits = sum(1 for keyword in keywords if _keyword_hit(answer, keyword))
    return hits / len(keywords)


def _keyword_hit(answer: str, keyword: str) -> bool:
    if keyword in answer:
        return True
    if len(keyword) <= 4:
        return False
    fragments = [part for part in _split_text(keyword) if len(part) >= 2]
    if not fragments:
        return False
    hit_count = sum(1 for fragment in fragments if fragment in answer)
    return hit_count / len(fragments) >= 0.5


def _extract_keywords(text: str) -> list[str]:
    keywords: list[str] = []
    for part in _split_text(text):
        cleaned = re.sub(r"\d+\s*分", "", part).strip("：:.-（）() ")
        if len(cleaned) < 2 or cleaned in GENERIC_TERMS:
            continue
        if len(cleaned) > 18:
            keywords.extend(_short_phrases(cleaned))
        else:
            keywords.append(cleaned)
    return _unique(keywords)[:24]


def _short_phrases(text: str) -> list[str]:
    phrases = re.findall(r"[\u4e00-\u9fffA-Za-z0-9]{2,10}", text)
    return [phrase for phrase in phrases if phrase not in GENERIC_TERMS and len(phrase) >= 2]


def _split_text(text: str) -> list[str]:
    return [
        part.strip()
        for part in re.split(r"[，,。；;、\n\r\s/]+", _plain_rubric_text(text))
        if part.strip()
    ]


def _plain_rubric_text(rubric: str) -> str:
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", rubric, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+[.)、]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"__(.*?)__", r"\1", text)
    return text.replace("`", "")


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
