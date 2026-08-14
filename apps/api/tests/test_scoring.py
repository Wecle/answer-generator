from copy import deepcopy

import pytest

from app.models import (
    AwardedBonus,
    ReviewDimension,
    RubricSchemaV2,
    TriggeredPenalty,
)
from app.services.scoring import compute_scoring_details
from tests.rubric_fixtures import normalized_schema_data, valid_schema_data


def normalized_schema() -> RubricSchemaV2:
    data = normalized_schema_data()
    data["dimensions"][0]["max_score"] = 60
    data["dimensions"][1]["max_score"] = 15
    data["scoring_policy"]["penalty_rules"] = [
        {
            "id": "PEN-DEDUCT",
            "text": "明确扣十分",
            "effect": "deduct",
            "score": 10,
            "source_requirement_ids": ["REQ-005"],
        },
        {
            "id": "PEN-CAP",
            "text": "最高七十分",
            "effect": "cap",
            "max_score": 70,
            "source_requirement_ids": ["REQ-005"],
        },
        {
            "id": "PEN-RANGE",
            "text": "掉到六十至七十分",
            "effect": "set_range",
            "min_score": 60,
            "max_score": 70,
            "source_requirement_ids": ["REQ-005"],
        },
        {
            "id": "PEN-QUALITATIVE",
            "text": "印象分大扣",
            "effect": "qualitative",
            "source_requirement_ids": ["REQ-006"],
        },
        {
            "id": "PEN-VETO",
            "text": "一票否决",
            "effect": "veto",
            "source_requirement_ids": ["REQ-006"],
        },
    ]
    return RubricSchemaV2.model_validate(data)


def dimensions(scores: list[int]) -> list[ReviewDimension]:
    return [
        ReviewDimension(
            dimension_id=dimension_id,
            name=dimension_id,
            score=score,
            max_score=999,
        )
        for dimension_id, score in zip(("DIM-001", "DIM-002"), scores)
    ]


def bonuses(scores: dict[str, int]) -> list[AwardedBonus]:
    return [
        AwardedBonus(bonus_rule_id=rule_id, score=score, reason=f"{rule_id} reason")
        for rule_id, score in scores.items()
    ]


def penalties(rule_ids: list[str]) -> list[TriggeredPenalty]:
    return [
        TriggeredPenalty(penalty_rule_id=rule_id, reason=f"{rule_id} reason")
        for rule_id in rule_ids
    ]


@pytest.mark.parametrize(
    ("dimension_scores", "bonus_scores", "penalty_ids", "expected"),
    [
        ([60, 10], {"BONUS-001": 4, "BONUS-002": 3}, [], 94),
        ([60, 10], {"BONUS-001": 9}, [], 85),
        ([60, 10], {"BONUS-001": 4}, ["PEN-CAP"], 70),
        ([40, 10], {}, ["PEN-RANGE"], 61),
    ],
)
def test_normalizes_dimensions_bonuses_and_penalties(
    dimension_scores, bonus_scores, penalty_ids, expected
):
    result = compute_scoring_details(
        normalized_schema(),
        dimensions(dimension_scores),
        bonuses(bonus_scores),
        penalties(penalty_ids),
    )

    assert result.final_score == expected


def test_applies_triggered_penalties_in_policy_source_order():
    result = compute_scoring_details(
        normalized_schema(),
        dimensions([60, 15]),
        bonuses({"BONUS-001": 4, "BONUS-002": 3}),
        penalties(
            [
                "PEN-VETO",
                "PEN-RANGE",
                "PEN-QUALITATIVE",
                "PEN-CAP",
                "PEN-DEDUCT",
            ]
        ),
    )

    assert result.normalized_score == 100
    assert result.final_score == 70
    assert result.vetoed is True
    assert [item.penalty_rule_id for item in result.triggered_penalties] == [
        "PEN-DEDUCT",
        "PEN-CAP",
        "PEN-RANGE",
        "PEN-QUALITATIVE",
        "PEN-VETO",
    ]


def test_qualitative_and_veto_do_not_change_numeric_score():
    plain = compute_scoring_details(normalized_schema(), dimensions([60, 10]), [], [])
    result = compute_scoring_details(
        normalized_schema(),
        dimensions([60, 10]),
        [],
        penalties(["PEN-QUALITATIVE", "PEN-VETO"]),
    )

    assert result.final_score == plain.final_score
    assert result.vetoed is True


def test_deduct_subtracts_the_declared_score():
    plain = compute_scoring_details(normalized_schema(), dimensions([60, 10]), [], [])
    result = compute_scoring_details(
        normalized_schema(), dimensions([60, 10]), [], penalties(["PEN-DEDUCT"])
    )

    assert result.final_score == plain.final_score - 10


def test_unknown_ids_are_ignored_and_known_reasons_are_preserved():
    supplied_dimensions = dimensions([60, 10]) + [
        ReviewDimension(
            dimension_id="DIM-UNKNOWN", name="unknown", score=999, max_score=999
        )
    ]
    result = compute_scoring_details(
        normalized_schema(),
        supplied_dimensions,
        bonuses({"BONUS-001": 4, "BONUS-UNKNOWN": 99}),
        penalties(["PEN-QUALITATIVE", "PEN-UNKNOWN"]),
    )

    assert result.base_score == 70
    assert [item.bonus_rule_id for item in result.awarded_bonuses] == [
        "BONUS-001",
        "BONUS-002",
    ]
    assert result.awarded_bonuses[0].reason == "BONUS-001 reason"
    assert [item.penalty_rule_id for item in result.triggered_penalties] == [
        "PEN-QUALITATIVE"
    ]
    assert result.triggered_penalties[0].reason == "PEN-QUALITATIVE reason"


def test_fixed_total_schema_returns_clamped_dimension_sum():
    schema = RubricSchemaV2.model_validate(valid_schema_data())
    result = compute_scoring_details(
        schema,
        dimensions([80, -10]),
        bonuses({"BONUS-UNKNOWN": 20}),
        penalties(["PEN-UNKNOWN"]),
    )

    assert result.base_score == 50
    assert result.raw_score == 50
    assert result.normalized_score == 50
    assert result.final_score == 50
    assert result.awarded_bonuses == []
    assert result.triggered_penalties == []
    assert result.vetoed is False


def test_scores_are_clamped_to_zero_and_one_hundred():
    high = compute_scoring_details(
        normalized_schema(),
        dimensions([999, 999]),
        bonuses({"BONUS-001": 4, "BONUS-002": 3}),
        [],
    )
    low = compute_scoring_details(
        normalized_schema(),
        dimensions([-10, -10]),
        [],
        penalties(["PEN-DEDUCT"]),
    )

    assert high.normalized_score == high.final_score == 100
    assert low.normalized_score == low.final_score == 0


def test_negative_bonus_award_is_replaced_with_zero():
    result = compute_scoring_details(
        normalized_schema(), dimensions([60, 10]), {"BONUS-001": -1}, []
    )

    assert result.awarded_bonuses[0].score == 0
    assert result.raw_score == 70


def test_linear_normalization_uses_python_round():
    data = deepcopy(normalized_schema_data())
    data["dimensions"] = [deepcopy(data["dimensions"][0])]
    data["dimensions"][0]["max_score"] = 8
    data["scoring_policy"]["base_max_score"] = 8
    data["scoring_policy"]["bonus_rules"] = []
    data["scoring_policy"]["normalization"]["raw_max_score"] = 8
    schema = RubricSchemaV2.model_validate(data)

    result = compute_scoring_details(
        schema,
        [ReviewDimension(dimension_id="DIM-001", name="test", score=1, max_score=8)],
        [],
        [],
    )

    assert result.normalized_score == 12  # round(12.5), using bankers' rounding
