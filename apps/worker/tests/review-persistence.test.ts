import assert from "node:assert/strict";
import test from "node:test";
import { toPersistedScoringDetails } from "../src/review-persistence";

test("maps every API scoring detail field to its persisted shape", () => {
  const result = toPersistedScoringDetails({
    base_score: 70,
    awarded_bonuses: [
      {
        bonus_rule_id: "BONUS-001",
        score: 4,
        reason: "画面感充分"
      }
    ],
    triggered_penalties: [
      {
        penalty_rule_id: "PEN-001",
        reason: "触发答非所问掉档"
      }
    ],
    raw_score: 74,
    normalized_score: 90,
    final_score: 0,
    vetoed: true
  });

  assert.deepEqual(result, {
    baseScore: 70,
    awardedBonuses: [
      {
        bonusRuleId: "BONUS-001",
        score: 4,
        reason: "画面感充分"
      }
    ],
    triggeredPenalties: [
      {
        penaltyRuleId: "PEN-001",
        reason: "触发答非所问掉档"
      }
    ],
    rawScore: 74,
    normalizedScore: 90,
    finalScore: 0,
    vetoed: true
  });
});
