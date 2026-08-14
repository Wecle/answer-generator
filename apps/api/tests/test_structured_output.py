import json

import httpx
import pytest

from app.models import RubricSchemaCandidate
from app.services.structured_output import (
    deepseek_strict_base_url,
    post_structured_completion,
    strict_json_schema,
)
from tests.rubric_fixtures import valid_candidate_data


def assert_strict_objects(node: object) -> None:
    if isinstance(node, dict):
        if node.get("type") == "object":
            properties = node.get("properties", {})
            assert node.get("additionalProperties") is False
            assert set(node.get("required", [])) == set(properties)
        assert "$ref" not in node
        assert "$defs" not in node
        assert "const" not in node
        assert "title" not in node
        assert "minItems" not in node
        assert "maxItems" not in node
        for value in node.values():
            assert_strict_objects(value)
    elif isinstance(node, list):
        for value in node:
            assert_strict_objects(value)


def test_deepseek_strict_base_url_is_deterministic():
    assert (
        deepseek_strict_base_url("https://api.deepseek.com")
        == "https://api.deepseek.com/beta"
    )
    assert (
        deepseek_strict_base_url("https://api.deepseek.com/v1")
        == "https://api.deepseek.com/beta"
    )
    assert deepseek_strict_base_url("https://api.openai.com/v1") is None


def test_strict_schema_inlines_refs_and_requires_every_property():
    schema = strict_json_schema(RubricSchemaCandidate)

    assert_strict_objects(schema)
    assert "inferred_scores" in schema["required"]
    assert schema["properties"]["version"]["enum"] == ["v2"]


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)
        self.request = httpx.Request(
            "POST", "https://api.deepseek.com/chat/completions"
        )

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "request failed", request=self.request, response=self
            )


class FakeClient:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    async def post(self, url, headers, json):
        self.calls.append((url, json))
        return self.responses.pop(0)


@pytest.mark.asyncio
async def test_deepseek_uses_required_strict_function_call():
    candidate = valid_candidate_data()
    client = FakeClient(
        [
            FakeResponse(
                {
                    "choices": [
                        {
                            "message": {
                                "content": None,
                                "tool_calls": [
                                    {
                                        "function": {
                                            "name": "submit_rubric_schema",
                                            "arguments": json.dumps(candidate),
                                        }
                                    }
                                ],
                            }
                        }
                    ]
                }
            )
        ]
    )

    result = await post_structured_completion(
        client=client,
        base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
        api_key="test-key",
        prompt="return JSON",
        system_prompt="compile rubric",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="Submit the complete rubric schema candidate.",
    )

    url, payload = client.calls[0]
    assert url == "https://api.deepseek.com/beta/chat/completions"
    assert payload["tools"][0]["function"]["strict"] is True
    assert payload["tool_choice"] == "required"
    assert len(payload["tools"]) == 1
    assert payload["tools"][0]["function"]["name"] == "submit_rubric_schema"
    assert result == candidate


@pytest.mark.asyncio
async def test_non_deepseek_uses_json_output_without_probe_request():
    candidate = valid_candidate_data()
    client = FakeClient(
        [
            FakeResponse(
                {"choices": [{"message": {"content": json.dumps(candidate)}}]}
            )
        ]
    )

    result = await post_structured_completion(
        client=client,
        base_url="https://example.test/v1",
        model="compatible-model",
        api_key="test-key",
        prompt="return JSON",
        system_prompt="compile rubric",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="Submit the complete rubric schema candidate.",
    )

    assert len(client.calls) == 1
    assert client.calls[0][0] == "https://example.test/v1/chat/completions"
    assert client.calls[0][1]["response_format"] == {"type": "json_object"}
    assert result == candidate


@pytest.mark.asyncio
async def test_strict_capability_rejection_falls_back_once_to_json_output():
    candidate = valid_candidate_data()
    client = FakeClient(
        [
            FakeResponse(
                {"error": {"message": "strict mode is not supported"}},
                status_code=400,
            ),
            FakeResponse(
                {"choices": [{"message": {"content": json.dumps(candidate)}}]}
            ),
        ]
    )

    result = await post_structured_completion(
        client=client,
        base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
        api_key="test-key",
        prompt="return JSON",
        system_prompt="compile rubric",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="Submit the complete rubric schema candidate.",
    )

    assert len(client.calls) == 2
    assert client.calls[1][0] == "https://api.deepseek.com/chat/completions"
    assert result == candidate


@pytest.mark.asyncio
async def test_strict_schema_rejection_falls_back_once_to_json_output():
    candidate = valid_candidate_data()
    client = FakeClient(
        [
            FakeResponse(
                {
                    "error": {
                        "message": (
                            "Invalid schema for function: unsupported keyword title"
                        )
                    }
                },
                status_code=400,
            ),
            FakeResponse(
                {"choices": [{"message": {"content": json.dumps(candidate)}}]}
            ),
        ]
    )

    result = await post_structured_completion(
        client=client,
        base_url="https://api.deepseek.com",
        model="deepseek-v4-pro",
        api_key="test-key",
        prompt="return JSON",
        system_prompt="compile rubric",
        output_model=RubricSchemaCandidate,
        function_name="submit_rubric_schema",
        function_description="Submit the complete rubric schema candidate.",
    )

    assert len(client.calls) == 2
    assert result == candidate


@pytest.mark.asyncio
async def test_authentication_failure_does_not_fall_back():
    client = FakeClient(
        [FakeResponse({"error": {"message": "invalid api key"}}, status_code=401)]
    )

    with pytest.raises(httpx.HTTPStatusError):
        await post_structured_completion(
            client=client,
            base_url="https://api.deepseek.com",
            model="deepseek-v4-pro",
            api_key="test-key",
            prompt="return JSON",
            system_prompt="compile rubric",
            output_model=RubricSchemaCandidate,
            function_name="submit_rubric_schema",
            function_description="Submit the complete rubric schema candidate.",
        )

    assert len(client.calls) == 1
