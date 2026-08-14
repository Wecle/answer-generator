import re

from pydantic import BaseModel

from app.models import GenerateAnswerRequest, PromptMetadata, RubricPenaltyRule


class PromptBuildResult(BaseModel):
    prompt: str
    metadata: PromptMetadata


def _is_multi_question(question: str) -> bool:
    named_blocks = re.findall(r"(?:^|\n)\s*(?:问题|第)\s*\d+", question)
    numbered_blocks = re.findall(r"(?:^|\n)\s*\d+\s*[.、．)]", question)
    return len(named_blocks) >= 2 or len(numbered_blocks) >= 2


def _format_penalty_effect(rule: RubricPenaltyRule) -> str:
    if rule.effect == "deduct":
        return f"deduct，扣{rule.score}分"
    if rule.effect == "cap":
        return f"cap，最高{rule.max_score}分"
    if rule.effect == "set_range":
        return f"set_range，限制到{rule.min_score}-{rule.max_score}分"
    if rule.effect == "veto":
        return "veto，一票否决"
    return "qualitative，仅作定性提醒"


def build_generation_prompt(request: GenerateAnswerRequest) -> PromptBuildResult:
    sections: list[tuple[str, str]] = []
    sections.append(
        (
            "base_role",
            request.rubric_schema.role_prompt
            + "\n请在内部判断核心作答任务并选择合适结构，完整回应题目中的所有作答要求，"
            "不要输出判断过程。",
        )
    )

    dimension_blocks: list[str] = []
    if request.rubric_schema.global_constraints:
        dimension_blocks.append(
            "全局要求\n"
            + "\n".join(
                f"- [{item.id}] {item.text}"
                for item in request.rubric_schema.global_constraints
            )
        )
    for dimension in request.rubric_schema.dimensions:
        lines = [f"{dimension.name}（{dimension.max_score} 分）"]
        lines.extend(
            f"- [{criterion.id}] {criterion.text}"
            for criterion in dimension.criteria
        )
        lines.extend(f"- 避免：{pitfall.text}" for pitfall in dimension.pitfalls)
        dimension_blocks.append("\n".join(lines))
    sections.append(
        (
            "rubric_constraints",
            "本题必须满足以下评分约束：\n" + "\n\n".join(dimension_blocks),
        )
    )

    scoring_policy = request.rubric_schema.scoring_policy
    if scoring_policy is not None:
        scoring_lines = ["可争取的加分项："]
        scoring_lines.extend(
            f"- [{rule.id}] {rule.text}（达到条件后加{rule.min_score}-{rule.max_score}分）"
            for rule in scoring_policy.bonus_rules
        )
        scoring_lines.append("必须避免的扣分或否决规则：")
        scoring_lines.extend(
            f"- [{rule.id}] {rule.text}（{_format_penalty_effect(rule)}）"
            for rule in scoring_policy.penalty_rules
        )
        sections.append(("scoring_rules", "\n".join(scoring_lines)))

    if request.material and request.material.strip():
        sections.append(("material", "材料：\n" + request.material.strip()))
    sections.append(("question", "题目：\n" + request.question.strip()))
    sections.append(
        (
            "length",
            f"篇幅要求：适合 {request.answer_minutes} 分钟口述，目标 {request.target_words} 字，"
            f"允许范围 {request.target_min_words}～{request.target_max_words} 字。",
        )
    )

    if _is_multi_question(request.question):
        sections.append(
            (
                "multi_question",
                "题目包含多个问题，请逐问完整回答，并使用“第 1 题”“第 2 题”分段。",
            )
        )
    feedback = request.previous_feedback
    if feedback and (
        feedback.failed_criteria
        or feedback.preserved_criteria_ids
        or feedback.reasons
    ):
        retry_lines = ["本轮是定向修复，请修复低分项并保留已满足内容："]
        retry_lines.extend(
            f"- [{item.criterion_id}] {item.repair_instruction}（{item.reason}）"
            for item in feedback.failed_criteria
        )
        if feedback.preserved_criteria_ids:
            retry_lines.append(
                "应保留：" + "、".join(feedback.preserved_criteria_ids)
            )
        if feedback.reasons:
            retry_lines.append(
                "补充原因：\n"
                + "\n".join(f"- {reason}" for reason in feedback.reasons)
            )
        sections.append(("retry_feedback", "\n".join(retry_lines)))

    sections.append(
        (
            "output_rules",
            "输出适合现场口述的纯文本；不得出现评分、审核、criterion ID、Markdown、批注、"
            "符号化停顿或舞台提示。",
        )
    )
    return PromptBuildResult(
        prompt="\n\n".join(content for _, content in sections),
        metadata=PromptMetadata(loaded_sections=[name for name, _ in sections]),
    )
