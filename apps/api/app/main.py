from fastapi import FastAPI, File, UploadFile

from app.config import load_project_env
from app.models import (
    GenerateAnswerRequest,
    GenerateAnswerResponse,
    ParseDocumentResponse,
    ReviewAnswerRequest,
    ReviewAnswerResponse,
    RunItemRequest,
    RunItemResponse,
)
from app.services.document_parser import parse_docx_questions
from app.services.generator import generate_answer
from app.services.orchestrator import run_item
from app.services.reviewer import review_answer

load_project_env()

app = FastAPI(title="Answer Generator AI Service", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ai/parse-docx", response_model=ParseDocumentResponse)
async def parse_docx(file: UploadFile = File(...)) -> ParseDocumentResponse:
    content = await file.read()
    questions = parse_docx_questions(content)
    return ParseDocumentResponse(questions=questions)


@app.post("/ai/generate-answer", response_model=GenerateAnswerResponse)
async def generate_answer_endpoint(request: GenerateAnswerRequest) -> GenerateAnswerResponse:
    return await generate_answer(request)


@app.post("/ai/review-answer", response_model=ReviewAnswerResponse)
async def review_answer_endpoint(request: ReviewAnswerRequest) -> ReviewAnswerResponse:
    return await review_answer(request)


@app.post("/ai/run-item", response_model=RunItemResponse)
async def run_item_endpoint(request: RunItemRequest) -> RunItemResponse:
    return await run_item(request)
