import json
import os
import re
from io import BytesIO
from typing import Any, List, Optional

import httpx
from docx import Document

from app.models import ParsedQuestion


QUESTION_MARKERS = ("？", "?", "请", "谈谈", "分析", "如何", "怎么看", "论述题", "论证题")
MATERIAL_MARKERS = ("材料", "背景", "资料", "给定材料")
TITLE_MARKERS = ("面试题", "真题", "区考", "省考", "国考", "事业单位", "结构化")


def parse_docx_questions(content: bytes) -> List[ParsedQuestion]:
    return parse_question_paragraphs(extract_docx_paragraphs(content))


async def parse_docx_questions_with_ai(content: bytes) -> List[ParsedQuestion]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("AI 解析需要配置 OPENAI_API_KEY")

    paragraphs = extract_docx_paragraphs(content)
    if not paragraphs:
        return []

    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    prompt = (
        "你是 Word 面试题解析器。请把以下 Word 段落解析成题目数组，只输出 JSON。\n"
        "JSON 格式：{\"questions\":[{\"title\":\"题目名称\",\"material\":\"材料，可为空\",\"question\":\"问题文本\"}]}。\n"
        "解析规则：\n"
        "1. 自动判断题目名称、材料、问题。\n"
        "2. 同一日期或同一套题下的多个问题可以放在同一个 question 字段里，用“问题 1”“问题 2”分段。\n"
        "3. material 只放独立的背景材料、情境材料或事实材料。\n"
        "4. question 必须保留考生需要回答的完整题干，包括题干中的案例描述、限定条件和作答要求。\n"
        "5. 如果一个段落既有情境信息又有作答要求，它属于 question。\n"
        "6. 如果文档没有独立材料段，material 必须为空字符串。\n"
        "7. 保留题干关键限定条件，不要改写题目含义。\n"
        "8. 不要把参考答案、评分标准、页眉页脚当成题目。\n\n"
        "Word 段落：\n"
        + "\n".join(f"{index + 1}. {paragraph}" for index, paragraph in enumerate(paragraphs))
    )

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是严谨的 Word 题目结构化解析器。"},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()

    data = json.loads(payload["choices"][0]["message"]["content"])
    questions = _questions_from_ai_data(data)
    if not questions:
        raise RuntimeError("AI 未能识别出题目")
    return questions


def extract_docx_paragraphs(content: bytes) -> List[str]:
    document = Document(BytesIO(content))
    return [p.text.strip() for p in document.paragraphs if p.text.strip()]


def parse_question_paragraphs(paragraphs: List[str]) -> List[ParsedQuestion]:
    titled_groups = _parse_titled_groups(paragraphs)
    if titled_groups:
        return titled_groups

    return _parse_legacy_questions(paragraphs)


def _parse_titled_groups(paragraphs: List[str]) -> List[ParsedQuestion]:
    groups: List[ParsedQuestion] = []
    current_title: Optional[str] = None
    materials: List[str] = []
    questions: List[str] = []
    pending_question = False

    def flush() -> None:
        nonlocal current_title, materials, questions, pending_question
        if current_title and questions:
            groups.append(
                ParsedQuestion(
                    title=current_title,
                    material="\n\n".join(materials).strip() or None,
                    question=_format_questions(questions),
                )
            )
        current_title = None
        materials = []
        questions = []
        pending_question = False

    for index, paragraph in enumerate(paragraphs):
        if _looks_like_title(paragraph):
            flush()
            current_title = _strip_title_prefix(paragraph)
            continue

        if not current_title:
            continue

        if _looks_like_material(paragraph):
            materials.append(_strip_section_prefix(paragraph))
            pending_question = False
            continue

        if _is_question_label(paragraph):
            pending_question = True
            continue

        if pending_question:
            questions.append(_strip_question_prefix(paragraph))
            pending_question = False
            continue

        if _starts_new_question(paragraph) or (not questions and _looks_like_question(paragraph)):
            questions.append(_strip_question_prefix(paragraph))
            continue

        if questions:
            questions[-1] = f"{questions[-1]}\n{paragraph}"
        elif materials:
            materials[-1] = f"{materials[-1]}\n{paragraph}"
        elif _looks_like_context_material(paragraph, following_paragraphs=paragraphs[index + 1 :]):
            materials.append(paragraph)
        else:
            questions.append(_strip_question_prefix(paragraph))

    flush()
    return groups


def _parse_legacy_questions(paragraphs: List[str]) -> List[ParsedQuestion]:
    questions: List[ParsedQuestion] = []
    material_buffer: List[str] = []
    current_material: Optional[str] = None

    for index, paragraph in enumerate(paragraphs):
        if _looks_like_material(paragraph):
            material_buffer.append(_strip_section_prefix(paragraph))
            current_material = "\n".join(material_buffer)
            continue

        if _looks_like_question(paragraph):
            questions.append(ParsedQuestion(material=current_material, question=_strip_question_prefix(paragraph)))
            material_buffer = []
            continue

        if material_buffer or _looks_like_context_material(paragraph, following_paragraphs=paragraphs[index + 1 :]):
            material_buffer.append(paragraph)
            current_material = "\n".join(material_buffer)

    if not questions and paragraphs:
        questions.append(ParsedQuestion(material=None, question="\n".join(paragraphs)))

    return questions


def _looks_like_title(text: str) -> bool:
    stripped = text.strip()
    if len(stripped) > 80:
        return False
    if any(marker in stripped for marker in TITLE_MARKERS):
        return True
    return bool(re.search(r"\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日", stripped))


def _looks_like_material(text: str) -> bool:
    return _has_explicit_material_marker(text) and not _looks_like_question(text)


def _looks_like_question(text: str) -> bool:
    if _has_explicit_material_marker(text):
        return False
    if re.match(r"^\s*(?:\d+\s*[、.．)]\s*)?[（(]\s*(?:论述题|论证题)\s*[)）]", text.strip()):
        return True
    stripped = _strip_question_prefix(text)
    if stripped.endswith(("？", "?")):
        return True
    if any(stripped.startswith(marker) for marker in QUESTION_MARKERS):
        return True
    if bool(re.match(r"^(问题|题目)\s*\d+", text.strip())):
        return True
    return False


def _starts_new_question(text: str) -> bool:
    stripped = text.strip()
    return bool(
        re.match(r"^(问题|题目)\s*\d+\s*[：:、.]?", stripped)
        or re.match(r"^\d+\s*[、.．)]\s*", stripped)
        or re.match(r"^[（(]\s*(?:论述题|论证题)\s*[)）]", stripped)
    )


def _looks_like_context_material(text: str, *, following_paragraphs: List[str]) -> bool:
    stripped = text.strip()
    if not stripped or _looks_like_title(stripped) or _looks_like_question(stripped):
        return False
    return any(_looks_like_question(paragraph) for paragraph in following_paragraphs)


def _has_explicit_material_marker(text: str) -> bool:
    prefix = text.strip()[:16]
    return any(marker in prefix for marker in MATERIAL_MARKERS)


def _is_question_label(text: str) -> bool:
    return bool(re.match(r"^(问题|题目)\s*\d+\s*[：:、.]?\s*$", text.strip()))


def _format_questions(questions: List[str]) -> str:
    return "\n\n".join(f"问题 {index + 1}\n{question.strip()}" for index, question in enumerate(questions) if question.strip())


def _strip_title_prefix(text: str) -> str:
    return re.sub(r"^题目名称\s*[：:]\s*", "", text.strip()).strip()


def _strip_section_prefix(text: str) -> str:
    return re.sub(r"^(材料|背景|资料|给定材料)\s*\d*\s*[：:、]?\s*", "", text.strip()).strip()


def _strip_question_prefix(text: str) -> str:
    stripped = text.strip()
    stripped = re.sub(r"^(问题|题目)\s*\d+\s*[：:、.]?\s*", "", stripped)
    stripped = re.sub(r"^\d+\s*[、.．)]\s*", "", stripped)
    return stripped.strip()


def _questions_from_ai_data(data: dict[str, Any]) -> List[ParsedQuestion]:
    raw_questions = data.get("questions")
    if not isinstance(raw_questions, list):
        return []

    questions: List[ParsedQuestion] = []
    for item in raw_questions:
        if not isinstance(item, dict):
            continue

        question = str(item.get("question") or "").strip()
        if not question:
            continue

        title = str(item.get("title") or "").strip() or None
        material = str(item.get("material") or "").strip() or None
        questions.append(ParsedQuestion(title=title, material=material, question=question))

    return questions
