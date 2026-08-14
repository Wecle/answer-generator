from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ParsedQuestion(BaseModel):
    title: Optional[str] = None
    material: Optional[str] = None
    question: str


class ParseDocumentResponse(BaseModel):
    questions: List[ParsedQuestion]


class SourceRequirement(BaseModel):
    id: str
    text: str
    kind: Literal["dimension", "criterion", "pitfall", "score", "global"]


class RubricCriterionSchema(BaseModel):
    id: str
    text: str
    source_requirement_ids: List[str] = Field(min_length=1)


class RubricPitfallSchema(BaseModel):
    id: str
    text: str
    source_requirement_ids: List[str] = Field(min_length=1)


class RubricGlobalConstraint(BaseModel):
    id: str
    text: str
    source_requirement_ids: List[str] = Field(min_length=1)


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


class RubricDimensionSchemaV2(BaseModel):
    id: str
    name: str
    max_score: int = Field(gt=0)
    source_requirement_ids: List[str] = Field(min_length=1)
    criteria: List[RubricCriterionSchema] = Field(min_length=1)
    pitfalls: List[RubricPitfallSchema] = Field(min_length=1)


class RubricCompilationMetadata(BaseModel):
    compiler_model: str
    auditor_model: Optional[str] = None
    coverage_passed: bool = False
    inferred_scores: bool = False


class RubricSchemaContent(BaseModel):
    version: Literal["v2"] = "v2"
    role_prompt: str
    source_requirements: List[SourceRequirement] = Field(min_length=1)
    global_constraints: List[RubricGlobalConstraint] = Field(default_factory=list)
    dimensions: List[RubricDimensionSchemaV2] = Field(min_length=1)
    scoring_policy: Optional[RubricScoringPolicy] = None
    answer_principles: List[str] = Field(default_factory=list)
    retry_policy: List[str] = Field(default_factory=list)
    output_rules: List[str] = Field(default_factory=list)


class RubricSchemaCandidate(RubricSchemaContent):
    inferred_scores: bool = False


class RubricSchemaV2(RubricSchemaContent):
    compilation: RubricCompilationMetadata


def build_rubric_schema(
    candidate: RubricSchemaCandidate, compiler_model: str
) -> RubricSchemaV2:
    candidate_data = candidate.model_dump()
    inferred_scores = candidate_data.pop("inferred_scores")
    return RubricSchemaV2.model_validate(
        {
            **candidate_data,
            "compilation": {
                "compiler_model": compiler_model,
                "auditor_model": None,
                "coverage_passed": False,
                "inferred_scores": inferred_scores,
            },
        }
    )


class CoverageConflict(BaseModel):
    requirement_id: str
    schema_path: str
    reason: str


class CoverageAuditResult(BaseModel):
    passed: bool
    missing_requirement_ids: List[str] = Field(default_factory=list)
    unsupported_schema_paths: List[str] = Field(default_factory=list)
    conflicts: List[CoverageConflict] = Field(default_factory=list)
    score_issues: List[str] = Field(default_factory=list)
    repair_instructions: List[str] = Field(default_factory=list)


class CompileRubricRequest(BaseModel):
    rubric: str
    answer_minutes: float = Field(gt=0)
    passing_score: int = Field(default=95, ge=0, le=100)


class CompileRubricResponse(BaseModel):
    rubric_schema: RubricSchemaV2
    compiler_model: str
    auditor_model: str


class FailedCriterion(BaseModel):
    criterion_id: str
    reason: str
    repair_instruction: str


class RetryFeedback(BaseModel):
    failed_criteria: List[FailedCriterion] = Field(default_factory=list)
    preserved_criteria_ids: List[str] = Field(default_factory=list)
    reasons: List[str] = Field(default_factory=list)


class PromptMetadata(BaseModel):
    pipeline_version: Literal["generation-pipe-v1"] = "generation-pipe-v1"
    schema_version: Literal["rubric-schema-v2"] = "rubric-schema-v2"
    base_prompt_version: Literal["base-v1"] = "base-v1"
    rubric_prompt_version: Literal["rubric-v1"] = "rubric-v1"
    retry_prompt_version: Literal["retry-v1"] = "retry-v1"
    loaded_sections: List[str]


class GenerateAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material: Optional[str] = None
    question: str
    rubric_schema: RubricSchemaV2
    answer_minutes: float = Field(gt=0)
    target_min_words: int = Field(gt=0)
    target_words: int = Field(gt=0)
    target_max_words: int = Field(gt=0)
    previous_feedback: Optional[RetryFeedback] = None

    @model_validator(mode="after")
    def validate_verified_schema_and_word_bounds(self) -> "GenerateAnswerRequest":
        if not self.rubric_schema.compilation.coverage_passed:
            raise ValueError("rubric_schema must pass coverage audit")
        if not self.target_min_words <= self.target_words <= self.target_max_words:
            raise ValueError("word bounds must satisfy min <= target <= max")
        return self


class GenerateAnswerResponse(BaseModel):
    answer: str
    model: str
    prompt_version: str = "generation-pipe-v1+rubric-schema-v2"
    prompt_metadata: PromptMetadata


class ReviewAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material: Optional[str] = None
    question: str
    rubric_schema: RubricSchemaV2
    answer: str
    passing_score: int = Field(default=95, ge=0, le=100)

    @model_validator(mode="after")
    def validate_verified_schema(self) -> "ReviewAnswerRequest":
        if not self.rubric_schema.compilation.coverage_passed:
            raise ValueError("rubric_schema must pass coverage audit")
        return self


class ReviewDimension(BaseModel):
    dimension_id: str
    name: str
    score: int
    max_score: int


class ReviewAnswerResponse(BaseModel):
    total_score: int
    passed: bool
    dimensions: List[ReviewDimension]
    failed_criteria: List[FailedCriterion] = Field(default_factory=list)
    preserved_criteria_ids: List[str] = Field(default_factory=list)
    reasons: List[str]
    reviewer_model: str


class RunItemRequest(GenerateAnswerRequest):
    passing_score: int = Field(default=95, ge=0, le=100)
    max_attempts: int = Field(default=3, ge=1, le=10)


class RunAttempt(BaseModel):
    attempt_number: int
    answer: str
    review: ReviewAnswerResponse


class RunItemResponse(BaseModel):
    status: Literal["passed", "needs_review"]
    attempts: List[RunAttempt]
    final_answer: str
    final_score: int
    reasons: List[str]
