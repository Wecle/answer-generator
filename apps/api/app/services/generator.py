import os
import re
from typing import List

import httpx

from app.models import GenerateAnswerRequest, GenerateAnswerResponse


PROMPT_VERSION = "v4"


async def generate_answer(request: GenerateAnswerRequest) -> GenerateAnswerResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for answer generation.")

    answer = _strip_markdown(await _generate_with_openai(request, api_key))
    return GenerateAnswerResponse(
        answer=answer,
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
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
        "1. 你需要先在内部判断本题主要考察的作答任务和测评要素，不要输出判断过程。\n"
        "2. 根据题目要求，自主选择最合适的公务员结构化面试作答结构。\n"
        "3. 常见作答任务包括但不限于：对现象、政策、观点进行分析评价；处理突发事件、投诉、舆情、现场冲突；"
        "组织活动、调研、宣传、培训、会议、专项整治；处理与领导、同事、群众、服务对象之间的沟通协调；"
        "结合岗位职责、个人认知、职业价值进行表达；进行情景模拟、劝说、汇报、演讲或现场发言；"
        "阅读材料后提炼问题、原因、影响和对策；多问并列题需要逐问回应。\n"
        "4. 评分标准、必须覆盖的评分项和上轮审核意见只作为内容约束，不得写成答案话术。\n"
        "5. 不要机械套用固定模板；如果题型混合，应以题目中最需要解决的核心任务为主线，融合其他要素。\n"
        "6. 不要在答案中出现“评分标准”“审核意见”“必须覆盖”等系统用语。\n"
        "7. 答案应像考生现场口述，结构清楚、内容具体、语言自然。\n"
        "8. 即使上轮审核意见提到停顿、重音、语速或节奏提示，也只能转化为自然口述表达；"
        "不得输出 // 注释、括号批注、重音符号、语速标记、旁白说明；不得输出舞台提示。\n"
        "9. 题目中包含多个问题时，按每个问题分别输出独立答案，格式为“第 1 题”后直接输出答案正文。\n"
        "10. 输出纯文本，禁止使用 Markdown 标题、加粗、列表符号、引用和代码块。"
    )


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


def _unique(values: List[str]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
