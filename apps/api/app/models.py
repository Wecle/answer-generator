from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ParsedQuestion(BaseModel):
    material: Optional[str] = None
    question: str


class ParseDocumentResponse(BaseModel):
    questions: List[ParsedQuestion]


class GenerateAnswerRequest(BaseModel):
    material: Optional[str] = None
    question: str
    rubric: str
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

