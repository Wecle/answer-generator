import os
from pathlib import Path


def load_project_env() -> None:
    env_path = _find_project_env(Path(__file__).resolve())
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue

        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), _strip_quotes(value.strip()))


def _strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _find_project_env(start_path: Path) -> Path:
    for directory in (start_path.parent, *start_path.parents):
        env_path = directory / ".env"
        if env_path.exists():
            return env_path
    return start_path.parent / ".env"
