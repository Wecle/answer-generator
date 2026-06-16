from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ParsedQuestion(BaseModel):
    title: Optional[str] = None
    material: Optional[str] = None
    question: str


class ParseDocumentResponse(BaseModel):
    questions: List[ParsedQuestion]


class RubricDimensionSchema(BaseModel):
    name: str
    max_score: int
    criteria: List[str] = Field(default_factory=list)
    pitfalls: List[str] = Field(default_factory=list)


class RubricSchema(BaseModel):
    role_prompt: str
    answer_principles: List[str] = Field(default_factory=list)
    dimensions: List[RubricDimensionSchema] = Field(default_factory=list)
    retry_policy: List[str] = Field(default_factory=list)
    output_rules: List[str] = Field(default_factory=list)


class CompileRubricRequest(BaseModel):
    rubric: str
    answer_minutes: float = Field(gt=0)
    passing_score: int = Field(default=95, ge=0, le=100)


class CompileRubricResponse(BaseModel):
    compiled_prompt: str
    rubric_schema: RubricSchema
    compiler_model: str


class GenerateAnswerRequest(BaseModel):
    material: Optional[str] = None
    question: str
    rubric: str
    compiled_prompt: Optional[str] = None
    rubric_schema: Optional[RubricSchema] = None
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
    rubric_schema: Optional[RubricSchema] = None
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
    rubric_schema: Optional[RubricSchema] = None
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
