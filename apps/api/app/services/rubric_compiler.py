import json
import os
from typing import Any

import httpx

from app.models import CompileRubricRequest, CompileRubricResponse, RubricDimensionSchema, RubricSchema


DEFAULT_ROLE_PROMPT = "你是一名参加公务员结构化面试的考生，需要生成符合评分标准、适合现场口述的文字参考答案。"

DEFAULT_ANSWER_PRINCIPLES = [
    "只围绕用户评分标准展开，不引入无关评分维度。",
    "每个评分维度都要有对应观点、分析或做法。",
    "答案需要适合规定时间内口述，表达自然、层次清楚。",
]

DEFAULT_RETRY_POLICY = [
    "低分重试时优先修复审核指出的低分维度和缺失条目。",
    "保留已覆盖的高分内容，定向改写低分段落。",
    "重试答案仍需保持自然口述，不输出评分表述、批注或舞台提示。",
]

DEFAULT_OUTPUT_RULES = [
    "输出纯文本。",
    "不使用 Markdown。",
    "多题目时按“第 1 题”分段。",
]


async def compile_rubric(request: CompileRubricRequest) -> CompileRubricResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for rubric compilation.")

    return await _compile_with_openai(request, api_key)


async def _compile_with_openai(request: CompileRubricRequest, api_key: str) -> CompileRubricResponse:
    base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    prompt = _build_compile_prompt(request)

    async with httpx.AsyncClient(timeout=60) as client:
        data = await _post_json_completion(client, base_url, model, api_key, prompt)

        try:
            schema = _schema_from_data(data, request)
        except ValueError as error:
            repair_prompt = _build_repair_prompt(request, data, str(error))
            repaired_data = await _post_json_completion(client, base_url, model, api_key, repair_prompt)
            schema = _schema_from_data(repaired_data, request)

    return CompileRubricResponse(
        compiled_prompt=_build_compiled_prompt(schema, request),
        rubric_schema=schema,
        compiler_model=model,
    )


def _build_compile_prompt(request: CompileRubricRequest) -> str:
    return (
        "请根据以下公务员面试评分标准，自行理解其真实评分结构，编译成稳定的答案生成与文字稿审核规则。只输出 JSON。\n"
        "JSON 字段：role_prompt, answer_principles, dimensions, retry_policy, output_rules。\n"
        "dimensions 每项字段：name, max_score, criteria, pitfalls。\n"
        "严格要求：每个 dimension 都必须包含非空 name、正整数 max_score、非空 criteria 数组、非空 pitfalls 数组。"
        "维度和分值必须来自用户评分标准；不要新增评分维度；criteria 只保留可执行得分点。"
        "评分标准可能是 Markdown、表格、散文、分档描述或混合格式，你必须基于语义识别真正的评分维度，"
        "不得把优/良/中/差等等级行、表格行、说明性标题、总则或示例误当成独立评分维度。\n\n"
        "重要约束：本系统生成和审核的是文字参考答案，不处理真实音频。"
        "如果评分标准包含语音表达、流畅度、语速语调等维度，需要转换成文字稿可评估的口述潜力要求，"
        "例如语句是否适合朗读、层次停顿是否清晰、篇幅是否符合答题时间、表达是否自然。"
        "不得把 role_prompt 写成录音评卷考官。\n\n"
        f"答题时间：{request.answer_minutes} 分钟\n"
        f"通过分数：{request.passing_score}\n"
        f"评分标准：\n{request.rubric}"
    )


def _build_repair_prompt(request: CompileRubricRequest, invalid_data: dict[str, Any], error_message: str) -> str:
    return (
        "请修复下面这份公务员面试评分标准编译 JSON。只输出修复后的完整 JSON，不要解释。\n"
        "修复要求：\n"
        "1. 保持 AI 对真实评分结构的语义理解，不使用规则模板或关键词硬切。\n"
        "2. 每个 dimension 必须包含非空 name、正整数 max_score、非空 criteria 数组、非空 pitfalls 数组。\n"
        "3. criteria 必须写成可执行得分点；pitfalls 必须写成该维度常见失分点。\n"
        "4. 不得把优/良/中/差等等级行、表格行、说明性标题、总则或示例误当成独立评分维度。\n\n"
        f"校验错误：{error_message}\n"
        f"答题时间：{request.answer_minutes} 分钟\n"
        f"通过分数：{request.passing_score}\n"
        f"原始评分标准：\n{request.rubric}\n\n"
        f"待修复 JSON：\n{json.dumps(invalid_data, ensure_ascii=False)}"
    )


async def _post_json_completion(client: httpx.AsyncClient, base_url: str, model: str, api_key: str, prompt: str) -> dict[str, Any]:
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
    return json.loads(content)

def _schema_from_data(data: dict[str, Any], request: CompileRubricRequest) -> RubricSchema:
    dimensions = data.get("dimensions")
    if not isinstance(dimensions, list) or not dimensions:
        raise ValueError("AI rubric schema must include non-empty dimensions.")

    parsed_dimensions = [_dimension_from_data(item) for item in dimensions if isinstance(item, dict)]
    if not parsed_dimensions:
        raise ValueError("AI rubric schema dimensions are invalid.")

    role_prompt = str(data.get("role_prompt") or "").strip() or DEFAULT_ROLE_PROMPT
    answer_principles = _string_list(data.get("answer_principles")) or DEFAULT_ANSWER_PRINCIPLES
    retry_policy = _string_list(data.get("retry_policy")) or DEFAULT_RETRY_POLICY
    output_rules = _string_list(data.get("output_rules")) or DEFAULT_OUTPUT_RULES

    return RubricSchema(
        role_prompt=role_prompt,
        answer_principles=answer_principles,
        dimensions=parsed_dimensions,
        retry_policy=retry_policy,
        output_rules=output_rules,
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


def _dimension_from_data(item: dict[str, Any]) -> RubricDimensionSchema:
    name = str(item.get("name") or "").strip()
    max_score = _positive_int(item.get("max_score"))
    criteria = _string_list(item.get("criteria"))
    pitfalls = _string_list(item.get("pitfalls"))

    if not name:
        raise ValueError("AI rubric schema dimensions must include name.")
    if max_score <= 0:
        raise ValueError(f"AI rubric schema dimension {name} must include positive max_score.")
    if not criteria:
        raise ValueError(f"AI rubric schema dimension {name} must include criteria.")
    if not pitfalls:
        raise ValueError(f"AI rubric schema dimension {name} must include pitfalls.")

    return RubricDimensionSchema(name=name, max_score=max_score, criteria=criteria, pitfalls=pitfalls)


def _positive_int(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]
