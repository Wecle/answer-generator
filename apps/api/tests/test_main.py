from fastapi.testclient import TestClient
import httpx

import app.main as main
from app.services.rubric_compiler import RubricCompilationError


def test_compile_endpoint_returns_structured_failure(monkeypatch):
    async def fail(_request):
        raise RubricCompilationError(
            stage="auditing_repaired_schema",
            code="COVERAGE_AUDIT_FAILED",
            message="评分标准覆盖审计失败",
            details={"missing_requirement_ids": ["REQ-004"]},
        )

    monkeypatch.setattr(main, "compile_rubric", fail)
    client = TestClient(main.app)

    response = client.post(
        "/ai/compile-rubric",
        json={"rubric": "评分标准", "answer_minutes": 2, "passing_score": 95},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == {
        "stage": "auditing_repaired_schema",
        "code": "COVERAGE_AUDIT_FAILED",
        "message": "评分标准覆盖审计失败",
        "details": {"missing_requirement_ids": ["REQ-004"]},
    }


def test_compile_rubric_endpoint_returns_bad_gateway_for_invalid_ai_schema(monkeypatch):
    async def failing_compile_rubric(request):
        raise ValueError("AI rubric schema dimension 审题准确度 must include criteria.")

    monkeypatch.setattr(main, "compile_rubric", failing_compile_rubric)
    client = TestClient(main.app)

    response = client.post(
        "/ai/compile-rubric",
        json={"rubric": "审题准确度15分", "answer_minutes": 3, "passing_score": 95},
    )

    assert response.status_code == 502
    assert "criteria" in response.json()["detail"]


def test_compile_rubric_endpoint_returns_gateway_timeout_for_ai_timeout(monkeypatch):
    async def timing_out_compile_rubric(request):
        raise httpx.ReadTimeout("model request timed out")

    monkeypatch.setattr(main, "compile_rubric", timing_out_compile_rubric)
    client = TestClient(main.app)

    response = client.post(
        "/ai/compile-rubric",
        json={"rubric": "审题准确度15分", "answer_minutes": 3, "passing_score": 95},
    )

    assert response.status_code == 504
    assert "超时" in response.json()["detail"]
