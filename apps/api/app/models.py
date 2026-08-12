from typing import List, Literal, Optional

from pydantic import BaseModel, Field


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


class RubricSchemaV2(BaseModel):
    version: Literal["v2"] = "v2"
    role_prompt: str
    source_requirements: List[SourceRequirement] = Field(min_length=1)
    global_constraints: List[RubricGlobalConstraint] = Field(default_factory=list)
    dimensions: List[RubricDimensionSchemaV2] = Field(min_length=1)
    answer_principles: List[str] = Field(default_factory=list)
    retry_policy: List[str] = Field(default_factory=list)
    output_rules: List[str] = Field(default_factory=list)
    compilation: RubricCompilationMetadata


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


class GenerateAnswerRequest(BaseModel):
    material: Optional[str] = None
    question: str
    rubric: str
    compiled_prompt: Optional[str] = None
    rubric_schema: Optional[RubricSchemaV2] = None
    answer_minutes: float = Field(gt=0)
    target_words: int = Field(gt=0)
    previous_feedback: List[str] = Field(default_factory=list)


class GenerateAnswerResponse(BaseModel):
    answer: str
    model: str
    prompt_version: str = "v1"


class ReviewAnswerRequest(BaseModel):
    material: Optional[str] = None
    question: str
    rubric: str
    rubric_schema: Optional[RubricSchemaV2] = None
    answer: str
    passing_score: int = Field(default=95, ge=0, le=100)


class ReviewDimension(BaseModel):
    name: str
    score: int
    max_score: int


class ReviewAnswerResponse(BaseModel):
    total_score: int
    passed: bool
    dimensions: List[ReviewDimension]
    reasons: List[str]
    reviewer_model: str


class RunItemRequest(BaseModel):
    material: Optional[str] = None
    question: str
    rubric: str
    compiled_prompt: Optional[str] = None
    rubric_schema: Optional[RubricSchemaV2] = None
    answer_minutes: float = Field(gt=0)
    target_words: int = Field(gt=0)
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
