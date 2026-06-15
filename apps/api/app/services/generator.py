import os
from typing import List

import httpx

from app.models import GenerateAnswerRequest, GenerateAnswerResponse


PROMPT_VERSION = "v1"


async def generate_answer(request: GenerateAnswerRequest) -> GenerateAnswerResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        answer = await _generate_with_openai(request, api_key)
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
    return (
        f"评分标准：\n{request.rubric}\n\n"
        f"材料：\n{request.material or '无材料'}\n\n"
        f"题目：\n{request.question}\n\n"
        f"答题时间：{request.answer_minutes} 分钟，目标字数约 {request.target_words} 字。\n"
        f"上轮审核意见：\n{feedback}\n\n"
        "请生成结构完整、论证充分、可直接朗读的中文面试答案。"
    )


def _generate_locally(request: GenerateAnswerRequest) -> str:
    keywords = _extract_keywords(request.rubric)
    feedback_line = "；".join(request.previous_feedback[:2]) if request.previous_feedback else "覆盖评分标准并强化论证层次"
    material_line = f"结合材料看，{request.material[:120]}。" if request.material else "结合题目场景看，需要兼顾问题识别、原因分析和对策落地。"
    keyword_line = "、".join(keywords[:6]) if keywords else "审题准确、逻辑清晰、措施可行"
    base = [
        f"各位考官，我认为这道题的关键在于围绕“{request.question[:48]}”建立清晰的分析框架。",
        material_line,
        f"第一，准确把握问题本质。作答时要体现{keyword_line}，把现象背后的治理目标、群众需求和执行条件讲清楚。",
        "第二，展开多维分析。既要看到制度设计、资源配置、协同机制等客观因素，也要关注干部作风、服务意识和群众参与等主观因素。",
        "第三，提出可执行措施。可以从调研摸底、分类施策、部门协同、过程监督、结果评估五个环节推进，确保措施能落地、能反馈、能改进。",
        f"第四，根据审核意见继续优化：{feedback_line}。",
        "最后，公务员面试答案既要有高度，也要有温度。只有把政策要求转化为群众可感知的服务成效，才能体现治理能力和责任担当。",
    ]
    answer = "\n".join(base)

    while _rough_word_count(answer) < request.target_words * 0.75:
        answer += "\n同时，在具体执行中要坚持问题导向和结果导向，明确责任主体、时间节点和评价标准，形成闭环管理。"

    return answer


def _extract_keywords(rubric: str) -> List[str]:
    separators = ["，", "。", "；", ";", "、", "\n", " "]
    text = rubric
    for separator in separators:
        text = text.replace(separator, "|")
    return [part.strip("：:.-") for part in text.split("|") if len(part.strip("：:.-")) >= 2]


def _rough_word_count(text: str) -> int:
    return len([char for char in text if not char.isspace()]) // 2

