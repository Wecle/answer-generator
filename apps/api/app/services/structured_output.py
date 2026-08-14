import json
from copy import deepcopy
from typing import Any, Optional, Type
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel


class StrictOutputUnsupported(RuntimeError):
    pass


STRICT_UNSUPPORTED_MARKERS = (
    "strict mode",
    "strict is not supported",
    "unsupported json schema",
    "invalid function schema",
    "invalid schema",
    "schema does not conform",
    "unsupported keyword",
    "beta feature",
)


def deepseek_strict_base_url(base_url: str) -> Optional[str]:
    parsed = urlparse(base_url)
    if parsed.hostname != "api.deepseek.com":
        return None
    return f"{parsed.scheme}://{parsed.netloc}/beta"


def strict_json_schema(model_type: Type[BaseModel]) -> dict[str, Any]:
    source = model_type.model_json_schema()
    definitions = source.pop("$defs", {})

    def normalize(node: Any) -> Any:
        if isinstance(node, list):
            return [normalize(value) for value in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            name = node["$ref"].removeprefix("#/$defs/")
            return normalize(deepcopy(definitions[name]))

        normalized = {
            key: normalize(value)
            for key, value in node.items()
            if key
            not in {"$defs", "default", "title", "minItems", "maxItems"}
        }
        if "const" in normalized:
            normalized["enum"] = [normalized.pop("const")]
        if normalized.get("type") == "object":
            properties = normalized.get("properties", {})
            normalized["required"] = list(properties)
            normalized["additionalProperties"] = False
        return normalized

    return normalize(source)


async def post_structured_completion(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    prompt: str,
    system_prompt: str,
    output_model: Type[BaseModel],
    function_name: str,
    function_description: str,
) -> dict[str, Any]:
    strict_base_url = deepseek_strict_base_url(base_url)
    if strict_base_url:
        try:
            return await _post_strict(
                client,
                strict_base_url,
                model,
                api_key,
                prompt,
                system_prompt,
                output_model,
                function_name,
                function_description,
            )
        except StrictOutputUnsupported:
            pass

    return await _post_json(
        client, base_url, model, api_key, prompt, system_prompt
    )


async def _post_strict(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    prompt: str,
    system_prompt: str,
    output_model: Type[BaseModel],
    function_name: str,
    function_description: str,
) -> dict[str, Any]:
    response = await client.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": function_name,
                        "strict": True,
                        "description": function_description,
                        "parameters": strict_json_schema(output_model),
                    },
                }
            ],
            # Thinking mode rejects named tool choices. Because this request
            # registers exactly one function, "required" still deterministically
            # selects the intended function while working in both modes.
            "tool_choice": "required",
        },
    )
    if response.status_code in {400, 404, 422} and any(
        marker in response.text.lower() for marker in STRICT_UNSUPPORTED_MARKERS
    ):
        raise StrictOutputUnsupported(response.text)
    response.raise_for_status()
    message = response.json()["choices"][0]["message"]
    selected = next(
        (
            call
            for call in message["tool_calls"]
            if call["function"]["name"] == function_name
        ),
        None,
    )
    if selected is None:
        raise KeyError(f"Missing forced tool call: {function_name}")
    return json.loads(selected["function"]["arguments"])


async def _post_json(
    client: httpx.AsyncClient,
    base_url: str,
    model: str,
    api_key: str,
    prompt: str,
    system_prompt: str,
) -> dict[str, Any]:
    response = await client.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
        },
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    return json.loads(content)
