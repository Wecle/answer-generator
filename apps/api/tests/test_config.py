from pathlib import Path

import app.config as config


def test_load_project_env_does_not_require_fixed_parent_depth(monkeypatch, tmp_path):
    config_file = tmp_path / "app" / "config.py"
    config_file.parent.mkdir()
    config_file.write_text("", encoding="utf-8")

    monkeypatch.setattr(config, "__file__", str(config_file))

    config.load_project_env()


def test_load_project_env_finds_env_from_ancestor(monkeypatch, tmp_path):
    config_file = tmp_path / "apps" / "api" / "app" / "config.py"
    config_file.parent.mkdir(parents=True)
    config_file.write_text("", encoding="utf-8")
    (tmp_path / ".env").write_text("ANSWER_GENERATOR_TEST_ENV='loaded'\n", encoding="utf-8")

    monkeypatch.setattr(config, "__file__", str(config_file))
    monkeypatch.delenv("ANSWER_GENERATOR_TEST_ENV", raising=False)

    config.load_project_env()

    assert config.os.environ["ANSWER_GENERATOR_TEST_ENV"] == "loaded"
