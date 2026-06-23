import json

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from app.config import load_project_env
from app.models import (
    CompileRubricRequest,
    CompileRubricResponse,
    GenerateAnswerRequest,
    GenerateAnswerResponse,
    ParseDocumentResponse,
    ReviewAnswerRequest,
    ReviewAnswerResponse,
    RunItemRequest,
    RunItemResponse,
)
from app.services.document_parser import parse_docx_questions, parse_docx_questions_with_ai
from app.services.generator import generate_answer
from app.services.orchestrator import run_item
from app.services.rubric_compiler import compile_rubric
from app.services.reviewer import review_answer

load_project_env()

app = FastAPI(title="Answer Generator AI Service", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ai/parse-docx", response_model=ParseDocumentResponse)
async def parse_docx(file: UploadFile = File(...), mode: str = Form("rules")) -> ParseDocumentResponse:
    content = await file.read()
    if mode == "ai":
        try:
            questions = await parse_docx_questions_with_ai(content)
        except RuntimeError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail="AI 解析失败，请检查模型服务或改用普通解析") from error
    else:
        questions = parse_docx_questions(content)
    return ParseDocumentResponse(questions=questions)


@app.post("/ai/compile-rubric", response_model=CompileRubricResponse)
async def compile_rubric_endpoint(request: CompileRubricRequest) -> CompileRubricResponse:
    try:
        return await compile_rubric(request)
    except RuntimeError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (ValueError, json.JSONDecodeError, httpx.HTTPError) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/ai/generate-answer", response_model=GenerateAnswerResponse)
async def generate_answer_endpoint(request: GenerateAnswerRequest) -> GenerateAnswerResponse:
    return await generate_answer(request)


@app.post("/ai/review-answer", response_model=ReviewAnswerResponse)
async def review_answer_endpoint(request: ReviewAnswerRequest) -> ReviewAnswerResponse:
    return await review_answer(request)


@app.post("/ai/run-item", response_model=RunItemResponse)
async def run_item_endpoint(request: RunItemRequest) -> RunItemResponse:
    return await run_item(request)
