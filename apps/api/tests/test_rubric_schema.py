import pytest

from app.models import RubricSchemaCandidate, RubricSchemaV2, build_rubric_schema
from app.services.rubric_schema import RubricSchemaValidationError, validate_rubric_schema
from tests.rubric_fixtures import (
    normalized_candidate_data,
    normalized_schema_data,
    valid_candidate_data,
    valid_schema_data,
)


def test_candidate_does_not_require_model_generated_compilation_metadata():
    candidate = RubricSchemaCandidate.model_validate(valid_candidate_data())

    assert candidate.inferred_scores is False
    assert "compilation" not in candidate.model_dump()


def test_server_builds_compilation_metadata_from_candidate():
    candidate = RubricSchemaCandidate.model_validate(valid_candidate_data())

    schema = build_rubric_schema(candidate, "deepseek-v4-pro")

    assert isinstance(schema, RubricSchemaV2)
    assert schema.compilation.compiler_model == "deepseek-v4-pro"
    assert schema.compilation.auditor_model is None
    assert schema.compilation.coverage_passed is False
    assert schema.compilation.inferred_scores is False


def test_candidate_parses_normalized_scoring_policy():
    candidate = RubricSchemaCandidate.model_validate(normalized_candidate_data())

    assert candidate.scoring_policy.mode == "normalized_rules"
    assert candidate.scoring_policy.bonus_rules[0].min_score == 2
    assert candidate.scoring_policy.penalty_rules[0].effect == "set_range"


def test_server_preserves_normalized_policy_while_owning_compilation_metadata():
    candidate = RubricSchemaCandidate.model_validate(normalized_candidate_data())

    schema = build_rubric_schema(candidate, "deepseek-v4-pro")

    assert schema.scoring_policy == candidate.scoring_policy
    assert schema.compilation.compiler_model == "deepseek-v4-pro"
    assert schema.compilation.auditor_model is None
    assert schema.compilation.coverage_passed is False


def test_normalized_policy_never_marks_explicit_scores_as_inferred():
    candidate_data = normalized_candidate_data()
    candidate_data["inferred_scores"] = True
    candidate = RubricSchemaCandidate.model_validate(candidate_data)

    schema = build_rubric_schema(candidate, "deepseek-v4-pro")

    assert schema.compilation.inferred_scores is False


def test_candidate_rejects_penalty_missing_required_effect_fields():
    data = normalized_candidate_data()
    data["scoring_policy"]["penalty_rules"][0].pop("max_score")

    with pytest.raises(ValueError, match="set_range requires min_score and max_score"):
        RubricSchemaCandidate.model_validate(data)


@pytest.mark.parametrize(
    "source_requirement_ids",
    [["REQ-003"], ["REQ-003", "REQ-003"]],
)
def test_candidate_rejects_score_conflict_without_two_distinct_sources(
    source_requirement_ids,
):
    data = normalized_candidate_data()
    data["scoring_policy"]["score_conflicts"][0]["source_requirement_ids"] = (
        source_requirement_ids
    )

    with pytest.raises(
        ValueError, match="score conflict requires at least two distinct sources"
    ):
        RubricSchemaCandidate.model_validate(data)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda data: data["scoring_policy"]["bonus_rules"][0].update({"id": " "}),
        lambda data: data["scoring_policy"]["bonus_rules"][0].update({"text": "\t"}),
        lambda data: data["scoring_policy"]["bonus_rules"][0].update(
            {"source_requirement_ids": [" "]}
        ),
        lambda data: data["scoring_policy"]["penalty_rules"][0].update(
            {"id": "\n"}
        ),
        lambda data: data["scoring_policy"]["penalty_rules"][0].update(
            {"text": " "}
        ),
        lambda data: data["scoring_policy"]["penalty_rules"][0].update(
            {"source_requirement_ids": ["\t"]}
        ),
        lambda data: data["scoring_policy"]["score_conflicts"][0].update(
            {"text": " "}
        ),
        lambda data: data["scoring_policy"]["score_conflicts"][0].update(
            {"source_requirement_ids": ["REQ-003", " "]}
        ),
    ],
)
def test_candidate_rejects_blank_scoring_policy_fields(mutate):
    data = normalized_candidate_data()
    mutate(data)

    with pytest.raises(ValueError, match="must not be blank"):
        RubricSchemaCandidate.model_validate(data)


def test_validator_accepts_complete_100_point_schema():
    validate_rubric_schema(RubricSchemaV2.model_validate(valid_schema_data()))


def test_validator_accepts_normalized_schema():
    validate_rubric_schema(RubricSchemaV2.model_validate(normalized_schema_data()))


def test_validator_accepts_mapped_global_constraint():
    data = valid_schema_data()
    data["source_requirements"].append(
        {"id": "REQ-003", "text": "结合基层实际", "kind": "global"}
    )
    data["global_constraints"] = [
        {
            "id": "GLB-001",
            "text": "结合基层实际",
            "source_requirement_ids": ["REQ-003"],
        }
    ]
    validate_rubric_schema(RubricSchemaV2.model_validate(data))


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (
            lambda data: data["dimensions"][1].update({"max_score": 40}),
            "INVALID_SCORE_TOTAL",
        ),
        (
            lambda data: data["dimensions"][1].update({"id": "DIM-001"}),
            "DUPLICATE_ID",
        ),
        (
            lambda data: data["dimensions"][0]["criteria"][0].update(
                {"source_requirement_ids": ["REQ-999"]}
            ),
            "UNKNOWN_REQUIREMENT",
        ),
        (
            lambda data: data["source_requirements"].append(
                {"id": "REQ-003", "text": "关注群众诉求", "kind": "criterion"}
            ),
            "UNMAPPED_REQUIREMENT",
        ),
    ],
)
def test_validator_rejects_invalid_schema(mutate, code):
    data = valid_schema_data()
    mutate(data)
    schema = RubricSchemaV2.model_validate(data)
    with pytest.raises(RubricSchemaValidationError) as error:
        validate_rubric_schema(schema)
    assert error.value.code == code


@pytest.mark.parametrize(
    ("mutate", "code"),
    [
        (
            lambda data: data["dimensions"][1].update({"max_score": 34}),
            "INVALID_BASE_SCORE_TOTAL",
        ),
        (
            lambda data: data["scoring_policy"]["normalization"].update(
                {"raw_max_score": 81}
            ),
            "INVALID_RAW_MAX_SCORE",
        ),
        (
            lambda data: data["scoring_policy"]["bonus_rules"][1].update(
                {"id": "BONUS-001"}
            ),
            "DUPLICATE_ID",
        ),
        (
            lambda data: data["scoring_policy"]["penalty_rules"][0].update(
                {"source_requirement_ids": ["REQ-999"]}
            ),
            "UNKNOWN_REQUIREMENT",
        ),
    ],
)
def test_validator_rejects_invalid_normalized_schema(mutate, code):
    data = normalized_schema_data()
    mutate(data)
    schema = RubricSchemaV2.model_validate(data)
    with pytest.raises(RubricSchemaValidationError) as error:
        validate_rubric_schema(schema)
    assert error.value.code == code
