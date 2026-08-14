from typing import Dict, Mapping, Sequence, Union

from app.models import (
    AwardedBonus,
    ReviewDimension,
    ReviewScoringDetails,
    RubricSchemaV2,
    TriggeredPenalty,
)


def _clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(value, maximum))


def compute_scoring_details(
    schema: RubricSchemaV2,
    dimensions: Sequence[ReviewDimension],
    bonuses: Union[Mapping[str, int], Sequence[AwardedBonus]],
    triggered_penalty_ids: Sequence[Union[str, TriggeredPenalty]],
) -> ReviewScoringDetails:
    """Recompute all numeric scoring results from schema-owned limits and rules."""
    supplied_dimensions = {item.dimension_id: item.score for item in dimensions}
    base_score = sum(
        _clamp(supplied_dimensions.get(rule.id, 0), 0, rule.max_score)
        for rule in schema.dimensions
    )

    policy = schema.scoring_policy
    if policy is None:
        score = _clamp(base_score, 0, 100)
        return ReviewScoringDetails(
            base_score=score,
            raw_score=score,
            normalized_score=score,
            final_score=score,
        )

    supplied_bonuses: Dict[str, AwardedBonus] = {}
    supplied_bonus_scores: Dict[str, int] = {}
    if isinstance(bonuses, Mapping):
        supplied_bonus_scores.update(bonuses)
    else:
        supplied_bonuses.update({item.bonus_rule_id: item for item in bonuses})
        supplied_bonus_scores.update(
            {item.bonus_rule_id: item.score for item in bonuses}
        )
    awarded_bonuses = []
    for rule in policy.bonus_rules:
        supplied = supplied_bonuses.get(rule.id)
        supplied_score = supplied_bonus_scores.get(rule.id, 0)
        score_is_valid = supplied_score == 0 or (
            rule.min_score <= supplied_score <= rule.max_score
        )
        awarded_bonuses.append(
            AwardedBonus(
                bonus_rule_id=rule.id,
                score=supplied_score if score_is_valid else 0,
                reason=supplied.reason if supplied is not None else rule.text,
            )
        )

    raw_score = base_score + sum(item.score for item in awarded_bonuses)
    normalized_score = _clamp(
        round(
            raw_score
            / policy.normalization.raw_max_score
            * policy.normalization.target_max_score
        ),
        0,
        100,
    )

    supplied_penalties: Dict[str, str] = {}
    for item in triggered_penalty_ids:
        if isinstance(item, str):
            supplied_penalties[item] = ""
        else:
            supplied_penalties[item.penalty_rule_id] = item.reason

    final_score = normalized_score
    vetoed = False
    triggered_penalties = []
    for rule in policy.penalty_rules:
        if rule.id not in supplied_penalties:
            continue

        reason = supplied_penalties[rule.id] or rule.text
        triggered_penalties.append(
            TriggeredPenalty(penalty_rule_id=rule.id, reason=reason)
        )
        if rule.effect == "deduct" and rule.score is not None:
            final_score -= rule.score
        elif rule.effect == "cap" and rule.max_score is not None:
            final_score = min(final_score, rule.max_score)
        elif rule.effect == "set_range" and rule.max_score is not None:
            # Never lift a low score to the declared range minimum.
            final_score = min(final_score, rule.max_score)
        elif rule.effect == "veto":
            vetoed = True

    return ReviewScoringDetails(
        base_score=base_score,
        awarded_bonuses=awarded_bonuses,
        triggered_penalties=triggered_penalties,
        raw_score=raw_score,
        normalized_score=normalized_score,
        final_score=_clamp(final_score, 0, 100),
        vetoed=vetoed,
    )
