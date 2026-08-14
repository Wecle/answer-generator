import pytest

from app.models import GenerateAnswerRequest
from app.services import generator
from app.services.generator import generate_answer
from app.services.prompt_pipe import build_generation_prompt
from tests.rubric_fixtures import valid_schema_data


def make_request(**overrides):
    schema = valid_schema_data()
    schema["compilation"]["auditor_model"] = "test-auditor"
    schema["compilation"]["coverage_passed"] = True
    values = {
        "question": "单位要组织一次基层调研，你会怎么开展？",
        "rubric_schema": schema,
        "answer_minutes": 3,
        "target_min_words": 600,
        "target_words": 700,
        "target_max_words": 800,
    }
    values.update(overrides)
    return GenerateAnswerRequest(**values)


def test_prompt_asks_model_to_choose_interview_structure_without_exposing_reasoning():
    result = build_generation_prompt(make_request())

    assert "内部判断核心作答任务并选择合适结构" in result.prompt
    assert "完整回应题目中的所有作答要求，不要输出判断过程" in result.prompt
    assert "准确分析问题" in result.prompt
    assert "评分标准" not in result.prompt
    assert result.metadata.pipeline_version == "generation-pipe-v1"


@pytest.mark.asyncio
async def test_generate_answer_requires_ai_configuration(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        await generate_answer(make_request())


@pytest.mark.asyncio
async def test_generate_answer_uses_composed_prompt_and_returns_metadata(monkeypatch):
    captured = {}

    async def fake_generate_with_openai(prompt, api_key):
        captured["prompt"] = prompt
        captured["api_key"] = api_key
        return "## 作答\n**先**开展调研。"

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(generator, "_generate_with_openai", fake_generate_with_openai)

    response = await generate_answer(make_request(material="某地正在推进基层治理改革。"))

    assert captured["api_key"] == "test-key"
    assert captured["prompt"].count("准确分析问题") == 1
    assert "某地正在推进基层治理改革" in captured["prompt"]
    assert "原始评分标准" not in captured["prompt"]
    assert response.answer == "作答\n先开展调研。"
    assert response.prompt_version == "generation-pipe-v1+rubric-schema-v2"
    assert response.prompt_metadata.loaded_sections == [
        "base_role",
        "rubric_constraints",
        "material",
        "question",
        "length",
        "output_rules",
    ]


def test_prompt_forbids_annotation_and_stage_direction_output():
    prompt = build_generation_prompt(make_request()).prompt

    assert "不得出现评分、审核、criterion ID、Markdown、批注" in prompt
    assert "符号化停顿或舞台提示" in prompt
    assert "输出适合现场口述的纯文本" in prompt
