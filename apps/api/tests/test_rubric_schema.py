import pytest

from app.models import RubricSchemaCandidate, RubricSchemaV2, build_rubric_schema
from app.services.rubric_schema import RubricSchemaValidationError, validate_rubric_schema
from tests.rubric_fixtures import valid_candidate_data, valid_schema_data


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


def test_validator_accepts_complete_100_point_schema():
    validate_rubric_schema(RubricSchemaV2.model_validate(valid_schema_data()))


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
