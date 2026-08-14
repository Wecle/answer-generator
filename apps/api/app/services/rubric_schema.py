from app.models import RubricSchemaV2


class RubricSchemaValidationError(ValueError):
    def __init__(self, code: str, details: dict):
        super().__init__(code)
        self.code = code
        self.details = details


def validate_rubric_schema(schema: RubricSchemaV2) -> None:
    ids = [requirement.id for requirement in schema.source_requirements]
    ids += [constraint.id for constraint in schema.global_constraints]
    ids += [dimension.id for dimension in schema.dimensions]
    ids += [
        criterion.id
        for dimension in schema.dimensions
        for criterion in dimension.criteria
    ]
    ids += [
        pitfall.id for dimension in schema.dimensions for pitfall in dimension.pitfalls
    ]
    if schema.scoring_policy is not None:
        ids += [rule.id for rule in schema.scoring_policy.bonus_rules]
        ids += [rule.id for rule in schema.scoring_policy.penalty_rules]
    duplicates = sorted({value for value in ids if ids.count(value) > 1})
    if duplicates:
        raise RubricSchemaValidationError("DUPLICATE_ID", {"ids": duplicates})

    names = [dimension.name.strip() for dimension in schema.dimensions]
    if len(set(names)) != len(names):
        raise RubricSchemaValidationError("DUPLICATE_DIMENSION", {"names": names})

    policy = schema.scoring_policy
    dimension_total = sum(dimension.max_score for dimension in schema.dimensions)
    if policy is None:
        if dimension_total != 100:
            raise RubricSchemaValidationError(
                "INVALID_SCORE_TOTAL", {"total": dimension_total}
            )
    else:
        if dimension_total != policy.base_max_score:
            raise RubricSchemaValidationError(
                "INVALID_BASE_SCORE_TOTAL",
                {"total": dimension_total, "expected": policy.base_max_score},
            )
        expected_raw_max = policy.base_max_score + sum(
            rule.max_score for rule in policy.bonus_rules
        )
        if policy.normalization.raw_max_score != expected_raw_max:
            raise RubricSchemaValidationError(
                "INVALID_RAW_MAX_SCORE",
                {
                    "actual": policy.normalization.raw_max_score,
                    "expected": expected_raw_max,
                },
            )

    requirement_ids = {
        requirement.id for requirement in schema.source_requirements
    }
    mapped_ids: set[str] = set()
    for constraint in schema.global_constraints:
        unknown = sorted(set(constraint.source_requirement_ids) - requirement_ids)
        if unknown:
            raise RubricSchemaValidationError(
                "UNKNOWN_REQUIREMENT", {"ids": unknown}
            )
        mapped_ids.update(constraint.source_requirement_ids)
    for dimension in schema.dimensions:
        references = list(dimension.source_requirement_ids)
        references += [
            item
            for criterion in dimension.criteria
            for item in criterion.source_requirement_ids
        ]
        references += [
            item
            for pitfall in dimension.pitfalls
            for item in pitfall.source_requirement_ids
        ]
        unknown = sorted(set(references) - requirement_ids)
        if unknown:
            raise RubricSchemaValidationError(
                "UNKNOWN_REQUIREMENT", {"ids": unknown}
            )
        mapped_ids.update(references)

    if policy is not None:
        policy_references = [
            requirement_id
            for rule in policy.bonus_rules
            for requirement_id in rule.source_requirement_ids
        ]
        policy_references += [
            requirement_id
            for rule in policy.penalty_rules
            for requirement_id in rule.source_requirement_ids
        ]
        policy_references += [
            requirement_id
            for conflict in policy.score_conflicts
            for requirement_id in conflict.source_requirement_ids
        ]
        unknown = sorted(set(policy_references) - requirement_ids)
        if unknown:
            raise RubricSchemaValidationError(
                "UNKNOWN_REQUIREMENT", {"ids": unknown}
            )
        mapped_ids.update(policy_references)

    unmapped = sorted(requirement_ids - mapped_ids)
    if unmapped:
        raise RubricSchemaValidationError("UNMAPPED_REQUIREMENT", {"ids": unmapped})
