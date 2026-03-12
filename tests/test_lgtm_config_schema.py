import json
from pathlib import Path

from scripts.load_trusted_review_config import (
    load_config_schema,
    normalize_config,
    parse_yaml_or_json,
    strip_legacy_defaults_effort,
    strip_legacy_reviewer_max_changed_lines,
    validate_config_against_schema,
)


def test_lgtm_config_schema_defaults_exposes_model_and_max_changed_lines() -> None:
    schema = json.loads(Path("schemas/lgtm-config.schema.json").read_text(encoding="utf-8"))
    defaults = schema["properties"]["defaults"]["properties"]

    assert "model" in defaults
    assert "max_changed_lines" in defaults
    assert "effort" not in defaults

    reviewer_props = schema["properties"]["reviewers"]["items"]["properties"]
    assert "max_changed_lines" not in reviewer_props


def test_lgtm_config_schema_accepts_legacy_defaults_effort_after_stripping() -> None:
    raw_config = """
version: 1
defaults:
  model: gpt-5.3-codex
  effort: xhigh
reviewers:
  - id: security
    display_name: Security
    prompt_file: examples/prompts/default/security.md
    scope: security risk
"""
    parsed = parse_yaml_or_json(raw_config, "test")
    stripped = strip_legacy_defaults_effort(parsed)

    validate_config_against_schema(stripped, load_config_schema(), "test")

    defaults = stripped.get("defaults")
    assert isinstance(defaults, dict)
    assert "model" in defaults
    assert "effort" not in defaults


def test_lgtm_config_schema_accepts_legacy_reviewer_max_changed_lines_after_stripping() -> None:
    raw_config = """
version: 1
defaults:
  model: gpt-5.3-codex
  max_changed_lines: 1200
reviewers:
  - id: security
    display_name: Security
    prompt_file: examples/prompts/default/security.md
    scope: security risk
    max_changed_lines: 300
"""
    parsed = parse_yaml_or_json(raw_config, "test")
    stripped = strip_legacy_reviewer_max_changed_lines(parsed)

    validate_config_against_schema(stripped, load_config_schema(), "test")

    reviewers = stripped.get("reviewers")
    assert isinstance(reviewers, list)
    assert "max_changed_lines" not in reviewers[0]


def test_normalize_config_resolves_global_max_changed_lines() -> None:
    normalized = normalize_config(
        {
            "version": 1,
            "defaults": {"model": "gpt-5.3-codex", "max_changed_lines": 1200},
            "reviewers": [
                {
                    "id": "security",
                    "display_name": "Security",
                    "prompt_file": "examples/prompts/default/security.md",
                    "scope": "security risk",
                },
                {
                    "id": "code_quality",
                    "display_name": "Code Quality",
                    "prompt_file": "examples/prompts/default/code-quality.md",
                    "scope": "maintainability",
                },
            ],
        }
    )

    defaults = normalized["defaults"]
    assert defaults == {"model": "gpt-5.3-codex", "max_changed_lines": 1200}

    reviewers = normalized["reviewers"]
    assert isinstance(reviewers, list)
    assert "max_changed_lines" not in reviewers[0]
    assert "max_changed_lines" not in reviewers[1]
