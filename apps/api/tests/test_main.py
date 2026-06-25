from fastapi.testclient import TestClient
import httpx

import app.main as main


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
