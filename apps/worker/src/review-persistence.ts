import type { PersistedScoringDetails } from "@answer-generator/shared";

export interface ReviewAnswerScoringDetails {
  base_score: number;
  awarded_bonuses: Array<{
    bonus_rule_id: string;
    score: number;
    reason: string;
  }>;
  triggered_penalties: Array<{
    penalty_rule_id: string;
    reason: string;
  }>;
  raw_score: number;
  normalized_score: number;
  final_score: number;
  vetoed: boolean;
}

export function toPersistedScoringDetails(
  details: ReviewAnswerScoringDetails
): PersistedScoringDetails {
  return {
    baseScore: details.base_score,
    awardedBonuses: details.awarded_bonuses.map((bonus) => ({
      bonusRuleId: bonus.bonus_rule_id,
      score: bonus.score,
      reason: bonus.reason
    })),
    triggeredPenalties: details.triggered_penalties.map((penalty) => ({
      penaltyRuleId: penalty.penalty_rule_id,
      reason: penalty.reason
    })),
    rawScore: details.raw_score,
    normalizedScore: details.normalized_score,
    finalScore: details.final_score,
    vetoed: details.vetoed
  };
}
