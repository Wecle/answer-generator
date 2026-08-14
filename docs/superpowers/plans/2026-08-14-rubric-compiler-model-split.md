# Rubric Compiler Model Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow rubric compilation, repair, and coverage audit to use `RUBRIC_COMPILER_MODEL` while all other AI flows continue using `OPENAI_MODEL`.

**Architecture:** Resolve the rubric compiler model once at the start of `_compile_with_openai` with a backward-compatible environment-variable fallback. Pass that one resolved model through every existing compile, repair, and audit call so request payloads and server-owned compilation metadata cannot diverge. Expose the optional variable through development, production, Docker, and README configuration surfaces.

**Tech Stack:** Python 3.9, FastAPI service modules, Pydantic 2, pytest, Docker Compose, Markdown configuration documentation.

## Global Constraints

- `RUBRIC_COMPILER_MODEL` affects only rubric compilation, structure repair, deterministic/audit repair, and coverage audit.
- Resolution order is non-empty `RUBRIC_COMPILER_MODEL`, non-empty `OPENAI_MODEL`, then `gpt-4o-mini`.
- `OPENAI_API_KEY` and `OPENAI_BASE_URL` remain shared; do not add compiler-specific key or base URL variables.
- Existing deployments without `RUBRIC_COMPILER_MODEL` retain their current behavior.
- Do not relax the non-empty `criteria` or `pitfalls` requirements.
- Do not add automatic Pro/Flash retries or rerun the failed task during implementation.

---

### Task 1: Resolve and use an independent rubric compiler model

**Files:**
- Modify: `apps/api/app/services/rubric_compiler.py:91-98`
- Modify: `apps/api/tests/test_rubric_compiler.py:12-22`
- Test: `apps/api/tests/test_rubric_compiler.py`

**Interfaces:**
- Consumes: environment variables `RUBRIC_COMPILER_MODEL` and `OPENAI_MODEL`.
- Produces: `_rubric_compiler_model() -> str`, used once by `_compile_with_openai`; all downstream functions continue receiving their existing `model: str` argument.

- [ ] **Step 1: Isolate tests from the developer's local compiler override**

Extend the autouse fixture so the test suite does not accidentally inherit a real local override:

```python
@pytest.fixture(autouse=True)
def stable_model_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.delenv("RUBRIC_COMPILER_MODEL", raising=False)
```

- [ ] **Step 2: Write failing override and fallback tests**

Add these tests beside the existing server-owned metadata test:

```python
@pytest.mark.asyncio
async def test_compile_pipeline_prefers_rubric_compiler_model(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "deepseek-v4-flash")
    monkeypatch.setenv("RUBRIC_COMPILER_MODEL", "deepseek-v4-pro")
    calls = install_fake_completions(
        monkeypatch,
        [
            json.dumps(valid_candidate_data(), ensure_ascii=False),
            json.dumps(audit_result(), ensure_ascii=False),
        ],
    )

    result = await _compile_with_openai(make_request(), "test-key")

    assert [call["model"] for call in calls] == [
        "deepseek-v4-pro",
        "deepseek-v4-pro",
    ]
    assert result.compiler_model == "deepseek-v4-pro"
    assert result.auditor_model == "deepseek-v4-pro"
    assert result.rubric_schema.compilation.compiler_model == "deepseek-v4-pro"
    assert result.rubric_schema.compilation.auditor_model == "deepseek-v4-pro"


def test_rubric_compiler_model_falls_back_to_openai_model(monkeypatch):
    monkeypatch.delenv("RUBRIC_COMPILER_MODEL", raising=False)
    monkeypatch.setenv("OPENAI_MODEL", "deepseek-v4-flash")

    assert rubric_compiler._rubric_compiler_model() == "deepseek-v4-flash"


def test_rubric_compiler_model_ignores_blank_values(monkeypatch):
    monkeypatch.setenv("RUBRIC_COMPILER_MODEL", "   ")
    monkeypatch.setenv("OPENAI_MODEL", "   ")

    assert rubric_compiler._rubric_compiler_model() == "gpt-4o-mini"
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
cd apps/api
./.venv/bin/python -m pytest -q tests/test_rubric_compiler.py -k "rubric_compiler_model or prefers_rubric"
```

Expected: FAIL because `_rubric_compiler_model` does not exist and compile requests still use `OPENAI_MODEL`.

- [ ] **Step 4: Implement the minimal resolver**

In `rubric_compiler.py`, add:

```python
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"


def _rubric_compiler_model() -> str:
    compiler_model = os.getenv("RUBRIC_COMPILER_MODEL", "").strip()
    if compiler_model:
        return compiler_model

    shared_model = os.getenv("OPENAI_MODEL", "").strip()
    return shared_model or DEFAULT_OPENAI_MODEL
```

Replace the existing model lookup in `_compile_with_openai`:

```python
model = _rubric_compiler_model()
```

Do not change downstream call signatures: the resolved `model` already flows through compilation, both repair paths, coverage audit, and compilation metadata.

- [ ] **Step 5: Run focused and full API tests**

Run:

```bash
cd apps/api
./.venv/bin/python -m pytest -q tests/test_rubric_compiler.py
./.venv/bin/python -m pytest -q
```

Expected: all rubric compiler tests pass; full API suite reports at least 62 passing tests and no failures.

- [ ] **Step 6: Commit the application behavior**

```bash
git add apps/api/app/services/rubric_compiler.py apps/api/tests/test_rubric_compiler.py
git commit -m "feat(api): configure rubric compiler model"
```

---

### Task 2: Expose the compiler model in deployment and documentation

**Files:**
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `docker-compose.yml:23-29`
- Modify: `README.md:80-101`
- Modify: `README.zh-CN.md:81-102`
- Modify locally without committing secrets: `.env`

**Interfaces:**
- Consumes: optional root environment variable `RUBRIC_COMPILER_MODEL`.
- Produces: the variable in the API container environment and documented examples; no application API changes.

- [ ] **Step 1: Add the variable to development and production examples**

Immediately after `OPENAI_MODEL` in both example files, add:

```env
RUBRIC_COMPILER_MODEL=
```

Keep it empty to demonstrate the backward-compatible fallback instead of assuming a particular provider.

- [ ] **Step 2: Forward the variable to the API container**

In `docker-compose.yml`, add after `OPENAI_MODEL`:

```yaml
      RUBRIC_COMPILER_MODEL: ${RUBRIC_COMPILER_MODEL:-}
```

- [ ] **Step 3: Update English configuration documentation**

Add the variable to the local environment example:

```env
OPENAI_MODEL=gpt-4o-mini
RUBRIC_COMPILER_MODEL=
```

Add this row to the environment table after `OPENAI_MODEL`:

```markdown
| `RUBRIC_COMPILER_MODEL` | Falls back to `OPENAI_MODEL` | Optional model used only for rubric compilation, repair, and coverage audit |
```

- [ ] **Step 4: Update Chinese configuration documentation**

Add the same variable to the local environment example and add this table row after `OPENAI_MODEL`:

```markdown
| `RUBRIC_COMPILER_MODEL` | 回退到 `OPENAI_MODEL` | 可选；仅用于评分标准编译、修复和覆盖审计的模型 |
```

- [ ] **Step 5: Configure the local model split without exposing secrets**

Ensure the ignored root `.env` contains these exact model settings while preserving every other local value:

```env
OPENAI_MODEL=deepseek-v4-flash
RUBRIC_COMPILER_MODEL=deepseek-v4-pro
```

Use `apply_patch`; do not print the complete `.env`, API key, or database credentials.

- [ ] **Step 6: Verify every configuration surface**

Run:

```bash
rg -n "RUBRIC_COMPILER_MODEL" \
  apps/api/app/services/rubric_compiler.py \
  apps/api/tests/test_rubric_compiler.py \
  .env.example .env.production.example docker-compose.yml \
  README.md README.zh-CN.md
git diff --check
git status --short
```

Expected: the variable appears in the resolver, tests, both examples, Compose, and both READMEs; `.env` does not appear in `git status`; `git diff --check` prints nothing.

- [ ] **Step 7: Run repository regression checks**

Run:

```bash
cd apps/api && ./.venv/bin/python -m pytest -q
cd ../.. && pnpm typecheck
```

Expected: all API tests and workspace typechecks pass.

- [ ] **Step 8: Commit configuration surfaces**

```bash
git add .env.example .env.production.example docker-compose.yml README.md README.zh-CN.md
git commit -m "docs: configure dedicated rubric compiler model"
```

The local `.env` remains ignored and must not be staged.
