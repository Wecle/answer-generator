from io import BytesIO
from typing import List, Optional

from docx import Document

from app.models import ParsedQuestion


QUESTION_MARKERS = ("？", "?", "请", "谈谈", "分析", "如何", "怎么看")
MATERIAL_MARKERS = ("材料", "背景", "资料")


def parse_docx_questions(content: bytes) -> List[ParsedQuestion]:
    document = Document(BytesIO(content))
    paragraphs = [p.text.strip() for p in document.paragraphs if p.text.strip()]
    return parse_question_paragraphs(paragraphs)


def parse_question_paragraphs(paragraphs: List[str]) -> List[ParsedQuestion]:
    questions: List[ParsedQuestion] = []
    material_buffer: List[str] = []
    current_material: Optional[str] = None

    for paragraph in paragraphs:
        if _looks_like_material(paragraph):
            if material_buffer:
                material_buffer.append(paragraph)
            else:
                material_buffer = [paragraph]
            current_material = "\n".join(material_buffer)
            continue

        if _looks_like_question(paragraph):
            questions.append(ParsedQuestion(material=current_material, question=_strip_number_prefix(paragraph)))
            material_buffer = []
            continue

        if material_buffer:
            material_buffer.append(paragraph)
            current_material = "\n".join(material_buffer)

    if not questions and paragraphs:
        questions.append(ParsedQuestion(material=None, question="\n".join(paragraphs)))

    return questions


def _looks_like_material(text: str) -> bool:
    prefix = text[:12]
    return any(marker in prefix for marker in MATERIAL_MARKERS) and not _looks_like_question(text)


def _looks_like_question(text: str) -> bool:
    stripped = _strip_number_prefix(text)
    return stripped.endswith(("？", "?")) or any(stripped.startswith(marker) for marker in QUESTION_MARKERS)


def _strip_number_prefix(text: str) -> str:
    stripped = text.strip()
    for separator in ("、", ".", "．", ")"):
        head, _, tail = stripped.partition(separator)
        if head.strip().isdigit() and tail.strip():
            return tail.strip()
    return stripped

