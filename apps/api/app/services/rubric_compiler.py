import json
import os
from typing import Any

import httpx

from app.models import CompileRubricRequest, CompileRubricResponse, RubricDimensionSchema, RubricSchema
from app.services.reviewer import parse_rubric_dimensions


async def compile_rubric(request: CompileRubricRequest) -> CompileRubricResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        try:
            return await _compile_with_openai(request, api_key)
        except Exception:
            pass

    schema = _compile_locally(request)
    return CompileRubricResponse(
        compiled_prompt=_build_compiled_prompt(schema, request),
        rubric_schema=schema,
        compiler_model="local-rubric-compiler-v1",
    )


async def _compile_with_openai(request: CompileRubricRequest, api_key: str) -> CompileRubricResponse:
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    prompt = (
        "请把以下公务员面试评分标准编译成稳定的答案生成与文字稿审核规则。只输出 JSON。\n"
        "JSON 字段：role_prompt, answer_principles, dimensions, retry_policy, output_rules。\n"
        "dimensions 每项字段：name, max_score, criteria, pitfalls。\n"
        "要求：维度和分值必须来自用户评分标准；不要新增评分维度；criteria 只保留可执行得分点。\n\n"
        "重要约束：本系统生成和审核的是文字参考答案，不处理真实音频。"
        "如果评分标准包含语音表达、流畅度、语速语调等维度，需要转换成文字稿可评估的口述潜力要求，"
        "例如语句是否适合朗读、层次停顿是否清晰、篇幅是否符合答题时间、表达是否自然。"
        "不得把 role_prompt 写成录音评卷考官。\n\n"
        f"答题时间：{request.answer_minutes} 分钟\n"
        f"通过分数：{request.passing_score}\n"
        f"评分标准：\n{request.rubric}"
    )

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是公务员面试评分标准编译器。"},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            },
        )
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        data = json.loads(content)

    schema = _schema_from_data(data, request)
    return CompileRubricResponse(
        compiled_prompt=_build_compiled_prompt(schema, request),
        rubric_schema=schema,
        compiler_model=model,
    )


def _compile_locally(request: CompileRubricRequest) -> RubricSchema:
    parsed_dimensions = parse_rubric_dimensions(request.rubric)
    dimensions = [
        RubricDimensionSchema(
            name=dimension.name,
            max_score=dimension.max_score,
            criteria=dimension.criteria,
            pitfalls=_default_pitfalls(dimension.criteria),
        )
        for dimension in parsed_dimensions
    ]

    return RubricSchema(
        role_prompt="你是一名参加公务员结构化面试的考生，需要生成符合用户评分标准、适合现场口述的文字参考答案。",
        answer_principles=[
            "只围绕用户评分标准展开，不引入额外评分维度。",
            "每个评分维度都要有对应观点、分析或做法。",
            "答案需要适合规定时间内口述，表达自然、层次清楚。",
        ],
        dimensions=dimensions,
        retry_policy=[
            "低分重试时优先补齐审核指出的缺失维度和缺失条目。",
            "保留已覆盖的高分内容，定向改写低分段落。",
            "重试答案仍需保持口述自然，避免机械堆砌评分词。",
        ],
        output_rules=[
            "输出纯文本。",
            "不使用 Markdown。",
            "多题目时按“第 1 题”分段。",
        ],
    )


def _schema_from_data(data: dict[str, Any], request: CompileRubricRequest) -> RubricSchema:
    local = _compile_locally(request)
    dimensions = data.get("dimensions")
    if not isinstance(dimensions, list) or not dimensions:
        return local

    return RubricSchema(
        role_prompt=str(data.get("role_prompt") or local.role_prompt),
        answer_principles=_string_list(data.get("answer_principles")) or local.answer_principles,
        dimensions=[
            RubricDimensionSchema(
                name=str(item.get("name") or local.dimensions[0].name),
                max_score=int(item.get("max_score") or 0),
                criteria=_string_list(item.get("criteria")),
                pitfalls=_string_list(item.get("pitfalls")),
            )
            for item in dimensions
            if isinstance(item, dict)
        ],
        retry_policy=_string_list(data.get("retry_policy")) or local.retry_policy,
        output_rules=_string_list(data.get("output_rules")) or local.output_rules,
    )


def _build_compiled_prompt(schema: RubricSchema, request: CompileRubricRequest) -> str:
    dimension_lines = []
    for dimension in schema.dimensions:
        criteria = "；".join(dimension.criteria) if dimension.criteria else "覆盖该维度要求"
        dimension_lines.append(f"- {dimension.name}（{dimension.max_score}分）：{criteria}")

    return "\n".join(
        [
            schema.role_prompt,
            f"答题时间为 {request.answer_minutes} 分钟，通过分数为 {request.passing_score} 分。",
            "作答原则：",
            *[f"- {item}" for item in schema.answer_principles],
            "评分维度：",
            *dimension_lines,
            "重试规则：",
            *[f"- {item}" for item in schema.retry_policy],
            "输出规则：",
            *[f"- {item}" for item in schema.output_rules],
        ]
    )


def _default_pitfalls(criteria: list[str]) -> list[str]:
    return [f"缺少或空泛处理：{item}" for item in criteria[:6]]


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]
