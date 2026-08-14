import os
import re

import httpx

from app.models import GenerateAnswerRequest, GenerateAnswerResponse
from app.services.prompt_pipe import build_generation_prompt


PROMPT_VERSION = "generation-pipe-v1+rubric-schema-v2"


async def generate_answer(request: GenerateAnswerRequest) -> GenerateAnswerResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for answer generation.")

    prompt_result = build_generation_prompt(request)
    answer = _strip_markdown(
        await _generate_with_openai(prompt_result.prompt, api_key)
    )
    return GenerateAnswerResponse(
        answer=answer,
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        prompt_version=PROMPT_VERSION,
        prompt_metadata=prompt_result.metadata,
    )


async def _generate_with_openai(prompt: str, api_key: str) -> str:
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": "你是公务员结构化面试高分答案生成助手。",
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.4,
            },
        )
        response.raise_for_status()
        payload = response.json()
        return payload["choices"][0]["message"]["content"].strip()


def _strip_markdown(text: str) -> str:
    cleaned = text.replace("```", "")
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*[-*+]\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*>\s?", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\*\*(.*?)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"__(.*?)__", r"\1", cleaned)
    cleaned = cleaned.replace("`", "")
    return cleaned.strip()
