# Complex Rubric Scoring Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Rubric Schema v2 to preserve fixed base scores, ranged bonuses, penalties, score conflicts, and a deterministic 100-point normalization policy while keeping historical fixed-total schemas compatible.

**Architecture:** Add an optional normalized scoring policy to the existing v2 schema in Python and TypeScript. Compilation and coverage audit preserve source scoring semantics; a focused server-side scoring engine computes raw, normalized, penalty-adjusted, and veto results from model-provided component facts. Persist the structured calculation in a nullable JSONB review column so historical records require no backfill.

**Tech Stack:** Python 3.9, Pydantic 2, FastAPI, pytest, TypeScript, Vitest, Node test runner, Drizzle ORM/Postgres JSONB, pnpm workspaces.

## Global Constraints

- `scoring_policy` remains optional on Rubric Schema v2; no v3 schema is introduced.
- A missing `scoring_policy` preserves the existing fixed-total rule: dimension `max_score` values sum to 100.
- `normalized_rules` preserves fixed base dimensions, ranged bonus rules, penalties, source conflicts, and linear normalization separately.
- The server, not the model, computes raw score, normalized score, penalties, veto, final score, and pass/fail.
- `target_max_score` is exactly 100 and normalization method is exactly `linear`.
- Unquantified qualitative rules never invent numeric deductions.
- Historical rubric JSON remains valid; historical review rows keep `scoring_details = null` and require no backfill.
- Do not automatically rerun task `f99f8143-7744-4055-845a-a6c60ce4dd40` during implementation.

---

### Task 1: Add normalized scoring policy models and deterministic validation

**Files:**
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/app/services/rubric_schema.py`
- Modify: `apps/api/tests/rubric_fixtures.py`
- Modify: `apps/api/tests/test_rubric_schema.py`

**Interfaces:**
- Produces Pydantic models `RubricBonusRule`, `RubricPenaltyRule`, `RubricScoreConflict`, `RubricNormalization`, and `RubricScoringPolicy`.
- Extends `RubricSchemaContent.scoring_policy: Optional[RubricScoringPolicy] = None`.
- `validate_rubric_schema(schema: RubricSchemaV2) -> None` accepts fixed-total and normalized schemas and continues raising `RubricSchemaValidationError(code, details)`.

- [ ] **Step 1: Add a normalized fixture and failing model tests**

Add `normalized_candidate_data()` and `normalized_schema_data()` to `rubric_fixtures.py`. Use two base dimensions totaling 75, two bonuses with maxima 4 and 3, one `set_range` penalty, one qualitative penalty, one score conflict, and `raw_max_score=82`.

```python
"scoring_policy": {
    "mode": "normalized_rules",
    "base_max_score": 75,
    "bonus_rules": [
        {
            "id": "BONUS-001",
            "text": "有画面可加2-4分",
            "min_score": 2,
            "max_score": 4,
            "source_requirement_ids": ["REQ-003"],
        },
        {
            "id": "BONUS-002",
            "text": "有人味儿可加2-3分",
            "min_score": 2,
            "max_score": 3,
            "source_requirement_ids": ["REQ-004"],
        },
    ],
    "penalty_rules": [
        {
            "id": "PEN-001",
            "text": "答非所问掉到60-70分",
            "effect": "set_range",
            "min_score": 60,
            "max_score": 70,
            "source_requirement_ids": ["REQ-005"],
        },
        {
            "id": "PEN-002",
            "text": "超时印象分大扣",
            "effect": "qualitative",
            "source_requirement_ids": ["REQ-006"],
        },
    ],
    "score_conflicts": [
        {
            "text": "档位标题与逐项上限不一致",
            "source_requirement_ids": ["REQ-003", "REQ-004"],
        }
    ],
    "normalization": {
        "raw_max_score": 82,
        "target_max_score": 100,
        "method": "linear",
    },
}
```

Tests must assert candidate parsing, server-owned metadata preservation, and rejection of an invalid penalty shape.

- [ ] **Step 2: Run the model tests and verify failure**

Run:

```bash
cd apps/api
./.venv/bin/python -m pytest -q tests/test_rubric_schema.py
```

Expected: FAIL because `scoring_policy` models and normalized validation do not exist.

- [ ] **Step 3: Implement exact Pydantic scoring types**

Add models with `ConfigDict(extra="forbid")` and validators:

```python
class RubricBonusRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    text: str
    min_score: int = Field(ge=0)
    max_score: int = Field(gt=0)
    source_requirement_ids: List[str] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_range(self) -> "RubricBonusRule":
        if self.min_score > self.max_score:
            raise ValueError("bonus min_score must not exceed max_score")
        return self


class RubricPenaltyRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    text: str
    effect: Literal["deduct", "cap", "set_range", "veto", "qualitative"]
    score: Optional[int] = Field(default=None, gt=0)
    min_score: Optional[int] = Field(default=None, ge=0, le=100)
    max_score: Optional[int] = Field(default=None, ge=0, le=100)
    source_requirement_ids: List[str] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_effect_fields(self) -> "RubricPenaltyRule":
        if self.effect == "deduct" and self.score is None:
            raise ValueError("deduct requires score")
        if self.effect == "cap" and self.max_score is None:
            raise ValueError("cap requires max_score")
        if self.effect == "set_range" and (
            self.min_score is None or self.max_score is None
        ):
            raise ValueError("set_range requires min_score and max_score")
        if (
            self.effect == "set_range"
            and self.min_score is not None
            and self.max_score is not None
            and self.min_score > self.max_score
        ):
            raise ValueError("penalty min_score must not exceed max_score")
        return self


class RubricScoreConflict(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    source_requirement_ids: List[str] = Field(min_length=1)


class RubricNormalization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    raw_max_score: int = Field(gt=0)
    target_max_score: Literal[100] = 100
    method: Literal["linear"] = "linear"


class RubricScoringPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["normalized_rules"] = "normalized_rules"
    base_max_score: int = Field(gt=0)
    bonus_rules: List[RubricBonusRule] = Field(default_factory=list)
    penalty_rules: List[RubricPenaltyRule] = Field(default_factory=list)
    score_conflicts: List[RubricScoreConflict] = Field(default_factory=list)
    normalization: RubricNormalization
```

Add `scoring_policy: Optional[RubricScoringPolicy] = None` to `RubricSchemaContent`. Because `RubricSchemaCandidate` inherits this content, no duplicate field is needed.

- [ ] **Step 4: Extend deterministic validation**

In `validate_rubric_schema`:

```python
policy = schema.scoring_policy
dimension_total = sum(dimension.max_score for dimension in schema.dimensions)
if policy is None:
    if dimension_total != 100:
        raise RubricSchemaValidationError("INVALID_SCORE_TOTAL", {"total": dimension_total})
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
```

Include bonus and penalty IDs in duplicate-ID detection. Include all bonus, penalty, and conflict `source_requirement_ids` in unknown-reference and mapped-requirement checks.

- [ ] **Step 5: Test validation error codes and compatibility**

Add parametrized mutations for `INVALID_BASE_SCORE_TOTAL`, `INVALID_RAW_MAX_SCORE`, duplicate bonus IDs, and unknown penalty requirement IDs. Keep `test_validator_accepts_complete_100_point_schema` unchanged to prove backward compatibility.

Run:

```bash
cd apps/api
./.venv/bin/python -m pytest -q tests/test_rubric_schema.py
```

Expected: all schema tests pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/api/app/models.py apps/api/app/services/rubric_schema.py apps/api/tests/rubric_fixtures.py apps/api/tests/test_rubric_schema.py
git commit -m "feat(api): model normalized rubric scoring"
```

---

### Task 2: Carry scoring policy through Shared, Web, and Worker boundaries

**Files:**
- Modify: `packages/shared/src/rubric-schema.ts`
- Modify: `packages/shared/tests/rubric-schema.test.ts`
- Modify: `apps/web/src/lib/rubric-compiler.ts`
- Modify: `apps/worker/src/ai-payloads.ts`
- Modify: `apps/worker/tests/fixtures.ts`
- Modify: `apps/worker/tests/ai-payloads.test.ts`

**Interfaces:**
- Produces TypeScript types `RubricScoringPolicy`, `RubricBonusRule`, `RubricPenaltyRule`, `RubricScoreConflict`, and `RubricNormalization` in camelCase.
- Extends `RubricSchemaV2.scoringPolicy?: RubricScoringPolicy | null`.
- Web converts API `scoring_policy` snake_case to Shared camelCase; Worker converts it back without information loss.

- [ ] **Step 1: Write failing Shared validation tests**

Extend `validSchemaData()` with an optional helper that changes dimension max to 75 and adds the normalized policy from Task 1 in camelCase. Assert it is accepted. Add invalid cases for incorrect base total, incorrect raw max, invalid bonus range, missing penalty effect fields, and unknown source IDs.

- [ ] **Step 2: Implement Shared types and runtime guards**

Add exact unions:

```typescript
export type RubricPenaltyEffect =
  | "deduct"
  | "cap"
  | "set_range"
  | "veto"
  | "qualitative";

export interface RubricScoringPolicy {
  mode: "normalized_rules";
  baseMaxScore: number;
  bonusRules: RubricBonusRule[];
  penaltyRules: RubricPenaltyRule[];
  scoreConflicts: RubricScoreConflict[];
  normalization: {
    rawMaxScore: number;
    targetMaxScore: 100;
    method: "linear";
  };
}
```

Implement `isScoringPolicy` and update `isVerifiedRubricSchemaV2` so a missing/null policy retains the 100-total check, while normalized mode validates base total, raw max, ranges, effect fields, unique IDs, known references, and complete source mapping.

- [ ] **Step 3: Update Web API conversion**

Extend `ApiRubricSchemaV2` with nullable `scoring_policy`, validate its snake_case fields, and map every nested rule in `toCamelSchema`. Do not infer values in Web code.

- [ ] **Step 4: Update Worker serialization tests and mapping**

Add a normalized policy to a copied worker fixture and assert both `buildGeneratePayload` and `buildReviewPayload` emit the exact snake_case object. Add `scoring_policy: schema.scoringPolicy ? ... : null` in `toApiRubricSchema`.

- [ ] **Step 5: Run boundary tests and typechecks**

```bash
pnpm --filter @answer-generator/shared test
pnpm --filter @answer-generator/worker test
pnpm typecheck
```

Expected: Shared and Worker tests pass; all workspace projects typecheck.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/shared/src/rubric-schema.ts packages/shared/tests/rubric-schema.test.ts apps/web/src/lib/rubric-compiler.ts apps/worker/src/ai-payloads.ts apps/worker/tests/fixtures.ts apps/worker/tests/ai-payloads.test.ts
git commit -m "feat(shared): carry rubric scoring policies"
```

---

### Task 3: Compile and audit complex scoring rules without forcing 100 fixed points

**Files:**
- Modify: `apps/api/app/services/rubric_compiler.py`
- Modify: `apps/api/tests/test_rubric_compiler.py`
- Modify: `apps/api/tests/test_structured_output.py`

**Interfaces:**
- Consumes `RubricSchemaCandidate.scoring_policy` from Task 1.
- Produces compile candidates where ranged bonuses and penalties are separate from fixed dimensions.
- Coverage audit treats fully mapped `score_conflicts` as preserved source facts rather than automatic failures.

- [ ] **Step 1: Add failing compiler prompt and pipeline tests**

Add tests that assert:

```python
prompt = rubric_compiler._build_compile_prompt(make_request())
assert "区间加分" in prompt
assert "bonus_rules" in prompt
assert "penalty_rules" in prompt
assert "score_conflicts" in prompt
assert "不得把区间加分合并成固定维度" in prompt
```

Add a fake normalized candidate and passing audit; assert `_compile_with_openai` returns a verified normalized schema with base total 75 and raw max 82 without entering repair.

- [ ] **Step 2: Extend the candidate example and compile prompt**

Add `"scoring_policy": None` to `RUBRIC_CANDIDATE_EXAMPLE`. Extend prompt rules:

```text
只有固定分且合计明确为100时，scoring_policy返回null。
存在基础分、区间加分、扣分、掉档、封顶或否决时，必须返回normalized_rules。
不得把区间加分合并成固定维度或为了凑100分推断固定权重。
区间加分写入bonus_rules；扣分、掉档、封顶、否决和无数值定性规则写入penalty_rules。
原文数值冲突必须同时保留双方，并写入score_conflicts。
raw_max_score必须等于base_max_score加所有bonus_rules.max_score。
```

- [ ] **Step 3: Extend audit and repair prompts**

Audit prompt must explicitly accept a conflict only when both source sides are mapped in `score_conflicts`, and must reject merged fixed scores or penalties hidden only as pitfalls. Repair prompts must preserve `scoring_policy` and must not convert normalized mode back into fixed total.

- [ ] **Step 4: Verify Strict schema compatibility**

Run `strict_json_schema(RubricSchemaCandidate)` tests and assert unsupported `minItems`, `maxItems`, `title`, and defaults remain absent while optional penalty fields are represented through supported `anyOf` null schemas.

- [ ] **Step 5: Run compiler and API tests**

```bash
cd apps/api
./.venv/bin/python -m pytest -q tests/test_rubric_compiler.py tests/test_structured_output.py
./.venv/bin/python -m pytest -q
```

Expected: compiler/adapter tests and complete API suite pass without a real model call.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/api/app/services/rubric_compiler.py apps/api/tests/test_rubric_compiler.py apps/api/tests/test_structured_output.py
git commit -m "feat(api): compile complex scoring policies"
```

---

### Task 4: Build the deterministic normalization and penalty engine

**Files:**
- Create: `apps/api/app/services/scoring.py`
- Create: `apps/api/tests/test_scoring.py`
- Modify: `apps/api/app/models.py`

**Interfaces:**
- Produces `compute_scoring_details(schema, dimensions, bonuses, triggered_penalty_ids) -> ReviewScoringDetails`.
- Adds response models `AwardedBonus`, `TriggeredPenalty`, and `ReviewScoringDetails`.
- Fixed-total schemas return raw, normalized, and final score equal to the clamped dimension sum.

- [ ] **Step 1: Write table-driven scoring tests**

Cover exact cases:

```python
@pytest.mark.parametrize(
    ("dimension_scores", "bonus_scores", "penalties", "expected"),
    [
        ([60, 10], {"BONUS-001": 4, "BONUS-002": 3}, [], 94),
        ([60, 10], {"BONUS-001": 9}, [], 85),  # invalid award becomes 0
        ([60, 10], {"BONUS-001": 4}, ["PEN-CAP"], 70),
        ([40, 10], {}, ["PEN-RANGE"], 61),  # no lift to range minimum
    ],
)
```

Also test `deduct`, `qualitative` no numeric change, `vetoed=True`, unknown IDs ignored, fixed-total compatibility, and 0–100 clamping. Use expected values computed from `round(raw / raw_max * 100)`.

- [ ] **Step 2: Add response models**

```python
class AwardedBonus(BaseModel):
    bonus_rule_id: str
    score: int = Field(ge=0)
    reason: str


class TriggeredPenalty(BaseModel):
    penalty_rule_id: str
    reason: str


class ReviewScoringDetails(BaseModel):
    base_score: int
    awarded_bonuses: List[AwardedBonus] = Field(default_factory=list)
    triggered_penalties: List[TriggeredPenalty] = Field(default_factory=list)
    raw_score: int
    normalized_score: int = Field(ge=0, le=100)
    final_score: int = Field(ge=0, le=100)
    vetoed: bool = False
```

- [ ] **Step 3: Implement the scoring engine**

Normalize known dimension scores by schema ID and clamp each to its max. Accept a bonus only when its score is 0 or within the source rule range; otherwise replace it with 0. Compute normalized score with Python `round`, then apply triggered rules in source order: `deduct`, `cap`, `set_range` as `min(current, max_score)`, `qualitative` unchanged, and `veto` only sets `vetoed=True`. Return server-reconstructed bonus and penalty records.

- [ ] **Step 4: Run scoring tests**

```bash
cd apps/api
./.venv/bin/python -m pytest -q tests/test_scoring.py
```

Expected: all scoring cases pass.

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/api/app/models.py apps/api/app/services/scoring.py apps/api/tests/test_scoring.py
git commit -m "feat(api): normalize complex rubric scores"
```

---

### Task 5: Integrate scoring details into generation and review

**Files:**
- Modify: `apps/api/app/services/prompt_pipe.py`
- Modify: `apps/api/app/services/reviewer.py`
- Modify: `apps/api/app/models.py`
- Modify: `apps/api/tests/test_prompt_pipe.py`
- Modify: `apps/api/tests/test_reviewer.py`

**Interfaces:**
- `ReviewAnswerResponse` adds `scoring_details: ReviewScoringDetails` and sets `total_score` from `scoring_details.final_score`.
- AI review JSON consumes `bonuses` and `triggered_penalties`; its claimed `total_score` and `passed` remain ignored.
- `passed` is `not vetoed and final_score >= passing_score`.

- [ ] **Step 1: Write failing prompt and reviewer tests**

Generation prompt test must contain bonus ranges and penalty effects but omit score-conflict text. Reviewer tests must prove a model-claimed total is ignored, valid bonuses normalize correctly, a triggered veto fails regardless of score, and fixed-total requests retain current totals.

- [ ] **Step 2: Add scoring constraints to generation Prompt**

When `scoring_policy` exists, append a `scoring_rules` section containing:

```text
可争取的加分项：
- [BONUS-001] 有画面（达到条件后加2-4分）
必须避免的扣分或否决规则：
- [PEN-001] 答非所问直接掉到60-70分（set_range）
```

Do not include `normalization` or `score_conflicts` in the answer-writing prompt.

- [ ] **Step 3: Extend AI review input and output contract**

Include scoring policy JSON in the reviewer prompt and require:

```json
{
  "dimensions": [{"dimension_id": "DIM-001", "score": 0}],
  "bonuses": [{"bonus_rule_id": "BONUS-001", "score": 0, "reason": "..."}],
  "triggered_penalties": [{"penalty_rule_id": "PEN-001", "reason": "..."}],
  "failed_criteria": [],
  "preserved_criteria_ids": [],
  "reasons": []
}
```

Normalize known bonus and penalty IDs, then call `compute_scoring_details`. Ignore unknown IDs and all model total/pass fields.

- [ ] **Step 4: Update local fallback**

Pass local dimension results with an empty bonus list and empty triggered-penalty list into `compute_scoring_details`. Add a reason explaining that subjective bonus and qualitative penalty rules were not inferred locally. Do not award or deduct numeric values without a deterministic trigger.

- [ ] **Step 5: Run focused and full API tests**

```bash
cd apps/api
./.venv/bin/python -m pytest -q tests/test_prompt_pipe.py tests/test_reviewer.py tests/test_scoring.py
./.venv/bin/python -m pytest -q
```

Expected: all focused and complete API tests pass.

- [ ] **Step 6: Commit Task 5**

```bash
git add apps/api/app/models.py apps/api/app/services/prompt_pipe.py apps/api/app/services/reviewer.py apps/api/tests/test_prompt_pipe.py apps/api/tests/test_reviewer.py
git commit -m "feat(api): review normalized rubric scores"
```

---

### Task 6: Persist scoring details and expose them after refresh

**Files:**
- Modify: `packages/shared/src/rubric-schema.ts`
- Modify: `packages/db/src/schema.ts`
- Create: generated `packages/db/migrations/0007_*.sql`
- Modify: generated `packages/db/migrations/meta/_journal.json`
- Create: generated `packages/db/migrations/meta/0007_snapshot.json`
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/tests/ai-payloads.test.ts` or add a focused persistence-mapping test file if extracting a helper
- Modify: `apps/web/src/components/dashboard/types.ts`

**Interfaces:**
- Produces Shared `PersistedScoringDetails` with camelCase fields matching `ReviewScoringDetails`.
- Adds nullable `answerGenerationReviews.scoringDetails` mapped to Postgres `scoring_details` JSONB.
- Worker maps API snake_case scoring details to persisted camelCase at both review insertion sites.

- [ ] **Step 1: Add Shared persistence types and DB column**

Define:

```typescript
export interface PersistedScoringDetails {
  baseScore: number;
  awardedBonuses: Array<{ bonusRuleId: string; score: number; reason: string }>;
  triggeredPenalties: Array<{ penaltyRuleId: string; reason: string }>;
  rawScore: number;
  normalizedScore: number;
  finalScore: number;
  vetoed: boolean;
}
```

In DB schema:

```typescript
scoringDetails: jsonb("scoring_details").$type<PersistedScoringDetails>(),
```

Keep it nullable and without a default.

- [ ] **Step 2: Generate and inspect the migration**

Run:

```bash
pnpm --filter @answer-generator/db db:generate
```

Expected generated SQL contains only:

```sql
ALTER TABLE "answer_generation_reviews" ADD COLUMN "scoring_details" jsonb;
```

Reject and regenerate if unrelated DDL appears.

- [ ] **Step 3: Map scoring details in Worker**

Extend `ReviewAnswerResponse` and extract a pure `toPersistedScoringDetails` helper. At both `answerGenerationReviews` insert sites add:

```typescript
scoringDetails: toPersistedScoringDetails(review.scoring_details),
```

The helper maps every snake_case field to the Shared camelCase interface. Add a Node test with bonuses, penalties, normalized score, and veto flag.

- [ ] **Step 4: Expose optional details in dashboard types**

Add `scoringDetails?: PersistedScoringDetails | null` to the persisted review shape in `apps/web/src/components/dashboard/types.ts`. No visual redesign is required; this ensures the GET job response survives typing and future display work.

- [ ] **Step 5: Run DB, Worker, Web, and workspace checks**

```bash
pnpm --filter @answer-generator/worker test
pnpm --filter @answer-generator/shared test
pnpm typecheck
```

Expected: all tests and typechecks pass.

- [ ] **Step 6: Commit Task 6**

```bash
git add packages/shared/src/rubric-schema.ts packages/db/src/schema.ts packages/db/migrations apps/worker/src/index.ts apps/worker/tests apps/web/src/components/dashboard/types.ts
git commit -m "feat(db): persist normalized scoring details"
```

---

### Task 7: End-to-end regression and task-specific fixture verification

**Files:**
- Modify only if a regression is found in the files owned by Tasks 1–6.
- Test: all existing API, Shared, Worker, Web, and build checks.

**Interfaces:**
- Consumes all prior tasks.
- Produces a clean branch with verified backward compatibility and normalized scoring support.

- [ ] **Step 1: Add a task-specific deterministic compilation fixture**

Create a compiler test candidate representing the reported source semantics: base total 75, seven ranged bonus rules with total maximum 22, `raw_max_score=97`, one `set_range` penalty, one qualitative penalty, and one recorded 90-vs-97 conflict. Feed it through fake compile and audit responses and assert compilation succeeds without repair.

- [ ] **Step 2: Run every test suite**

```bash
cd apps/api && ./.venv/bin/python -m pytest -q
cd ../.. && pnpm --filter @answer-generator/shared test
pnpm --filter @answer-generator/worker test
pnpm --filter @answer-generator/web test
pnpm typecheck
pnpm --filter @answer-generator/web build
```

Expected: all suites, typechecks, and production Web build pass.

- [ ] **Step 3: Validate migrations and diff**

```bash
git diff --check
git status --short
rg -n "scoring_policy|scoring_details|normalized_rules" apps packages
```

Expected: no whitespace errors, no secret files, and every boundary contains the intended fields.

- [ ] **Step 4: Perform an independent code review**

Review the complete range from the commit before Task 1 through HEAD. Fix all Critical and Important findings, rerun affected tests, and record Minor findings in the handoff if intentionally deferred.

- [ ] **Step 5: Commit any regression-only fixes**

If Step 2–4 required changes:

```bash
git add apps/api apps/worker packages/shared packages/db apps/web/src/lib/rubric-compiler.ts apps/web/src/components/dashboard/types.ts
git commit -m "fix: complete normalized rubric scoring"
```

If no files changed, do not create an empty commit.

- [ ] **Step 6: Handoff without rerunning the paid task**

Report migration requirements, test totals, final commits, and that task `f99f8143-7744-4055-845a-a6c60ce4dd40` still requires an explicit user-triggered recompile after API/Worker restart and database migration.
