import os
import re
from typing import List

import httpx

from app.models import GenerateAnswerRequest, GenerateAnswerResponse


PROMPT_VERSION = "v3"


async def generate_answer(request: GenerateAnswerRequest) -> GenerateAnswerResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        answer = _strip_markdown(await _generate_with_openai(request, api_key))
        return GenerateAnswerResponse(
            answer=answer,
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            prompt_version=PROMPT_VERSION,
        )

    return GenerateAnswerResponse(
        answer=_generate_locally(request),
        model="local-deterministic",
        prompt_version=PROMPT_VERSION,
    )


async def _generate_with_openai(request: GenerateAnswerRequest, api_key: str) -> str:
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    prompt = _build_prompt(request)

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是公务员结构化面试高分答案生成助手。"},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.4,
            },
        )
        response.raise_for_status()
        payload = response.json()
        return payload["choices"][0]["message"]["content"].strip()


def _build_prompt(request: GenerateAnswerRequest) -> str:
    feedback = "\n".join(f"- {item}" for item in request.previous_feedback) or "无"
    rubric_checklist = "\n".join(f"- {item}" for item in _focus_points(request)) or "- 完整覆盖评分标准"
    compiled_prompt = request.compiled_prompt or "请严格按照用户评分标准进行作答。"
    return (
        f"任务核心提示词：\n{compiled_prompt}\n\n"
        f"评分标准：\n{request.rubric}\n\n"
        f"必须覆盖的评分项：\n{rubric_checklist}\n\n"
        f"材料：\n{request.material or '无材料'}\n\n"
        f"题目：\n{request.question}\n\n"
        f"答题时间：{request.answer_minutes} 分钟，目标字数约 {request.target_words} 字。\n"
        f"上轮审核意见：\n{feedback}\n\n"
        "生成要求：\n"
        "1. 只以用户填写的评分标准作为生成依据，逐项覆盖必须覆盖的评分项。\n"
        "2. 如果存在上轮审核意见，优先修复低分项，并把缺失要点写成具体内容。\n"
        "3. 题目中包含多个问题时，按每个问题分别输出独立答案，格式为“第 1 题”后直接输出答案正文。\n"
        "4. 输出纯文本，禁止使用 Markdown 标题、加粗、列表符号、引用和代码块。"
    )


def _generate_locally(request: GenerateAnswerRequest) -> str:
    focus_points = _unique(_focus_points(request) + _extract_feedback_keywords(request.previous_feedback))
    keywords = _unique(_extract_keywords("；".join(focus_points)) + _extract_keywords(request.rubric))
    feedback_line = "；".join(request.previous_feedback[:3]) if request.previous_feedback else "覆盖评分标准并强化论证层次"
    keyword_line = "、".join(keywords[:10]) if keywords else "审题准确、逻辑清晰、措施可行"
    questions = _split_blocks("问题", request.question)
    materials = _split_blocks("材料", request.material or "")
    sections: list[str] = []

    for index, question in enumerate(questions):
        material = _material_for_question(materials, index)
        answer = _generate_local_question_answer(request, question, material, keyword_line, feedback_line, focus_points)
        sections.append(f"第 {index + 1} 题\n{answer}")

    return "\n\n".join(sections)


def _generate_local_question_answer(
    request: GenerateAnswerRequest,
    question: str,
    material: str,
    keyword_line: str,
    feedback_line: str,
    focus_points: list[str],
) -> str:
    material_line = f"结合材料看，{material[:120]}。" if material else "结合题目要求看，需要直接回应问题。"
    improvement_line = f"本轮作答要重点补足：{feedback_line}。"
    focus_line = "；".join(focus_points[:8]) if focus_points else keyword_line
    base = [
        f"各位考官，我认为这道题的关键在于围绕“{question[:48]}”建立清晰的分析框架。",
        material_line,
        f"第一，严格对应评分标准。围绕{keyword_line}展开，确保答案内容能够覆盖用户设定的评分项。",
        f"第二，逐项补齐评分要点。重点回应：{focus_line}，每个要点都写成明确观点、具体分析或可执行做法。",
        f"第三，针对审核意见继续优化。{improvement_line}",
        "最后，回到题目本身收束观点，确保答案和评分标准保持一致。",
    ]
    answer = "\n".join(base)

    while _rough_word_count(answer) < request.target_words * 0.75:
        answer += "\n同时，在具体执行中要坚持问题导向和结果导向，明确责任主体、时间节点和评价标准，形成闭环管理。"
    return answer


def _rubric_focus_points(rubric: str) -> List[str]:
    points: List[str] = []
    for raw_line in rubric.splitlines():
        line = _clean_markdown_line(raw_line)
        if not line:
            continue
        if _looks_like_rubric_intro(line):
            continue
        if len(line) > 60:
            points.extend(_extract_keywords(line)[:4])
        else:
            points.append(line)
    return _unique(points)[:18]


def _focus_points(request: GenerateAnswerRequest) -> List[str]:
    if request.rubric_schema and request.rubric_schema.dimensions:
        points: List[str] = []
        for dimension in request.rubric_schema.dimensions:
            criteria = "；".join(dimension.criteria) if dimension.criteria else dimension.name
            points.append(f"{dimension.name}（{dimension.max_score}分）：{criteria}")
            points.extend(dimension.criteria)
        return _unique(points)[:24]

    return _rubric_focus_points(request.rubric)


def _clean_markdown_line(line: str) -> str:
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s*", "", line.strip())
    cleaned = re.sub(r"^\s*[-*+]\s+", "", cleaned)
    cleaned = re.sub(r"^\s*\d+[.)、]\s+", "", cleaned)
    cleaned = re.sub(r"\*\*(.*?)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"__(.*?)__", r"\1", cleaned)
    return cleaned.replace("`", "").strip()


def _looks_like_rubric_intro(line: str) -> bool:
    return any(term in line for term in ("评分细则适用于", "总分100分", "不包含仪态", "各维度评分标准"))


def _split_blocks(label: str, text: str) -> list[str]:
    stripped = text.strip()
    if not stripped:
        return []

    pattern = re.compile(rf"^\s*{re.escape(label)}\s*\d*\s*[：:]?\s*$", re.MULTILINE)
    matches = list(pattern.finditer(stripped))
    if not matches:
        return [stripped]

    blocks: list[str] = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(stripped)
        block = stripped[start:end].strip()
        if block:
            blocks.append(block)

    return blocks or [stripped]


def _material_for_question(materials: list[str], index: int) -> str:
    if not materials:
        return ""
    if len(materials) > 1 and index < len(materials):
        return materials[index]
    return "\n".join(materials)


def _strip_markdown(text: str) -> str:
    cleaned = text.replace("```", "")
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*[-*+]\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*>\s?", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\*\*(.*?)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"__(.*?)__", r"\1", cleaned)
    cleaned = cleaned.replace("`", "")
    return cleaned.strip()


def _extract_keywords(rubric: str) -> List[str]:
    separators = ["，", "。", "；", ";", "、", "\n", " "]
    text = _plain_rubric_text(rubric)
    for separator in separators:
        text = text.replace(separator, "|")
    return [part.strip("：:.-") for part in text.split("|") if len(part.strip("：:.-")) >= 2]


def _plain_rubric_text(rubric: str) -> str:
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", rubric, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"__(.*?)__", r"\1", text)
    return text.replace("`", "")


def _extract_feedback_keywords(feedback: List[str]) -> List[str]:
    keywords: List[str] = []
    for item in feedback:
        if "必须补充：" not in item:
            continue
        tail = item.split("必须补充：", 1)[1].split("。", 1)[0]
        keywords.extend(_extract_keywords(tail))
    return keywords


def _unique(values: List[str]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _rough_word_count(text: str) -> int:
    return len([char for char in text if not char.isspace()]) // 2
