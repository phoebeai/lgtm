import json
from pathlib import Path

from scripts.load_trusted_review_config import (
    load_config_schema,
    parse_yaml_or_json,
    strip_legacy_defaults_effort,
    validate_config_against_schema,
)


def test_lgtm_config_schema_defaults_only_exposes_model() -> None:
    schema = json.loads(Path("schemas/lgtm-config.schema.json").read_text(encoding="utf-8"))
    defaults = schema["properties"]["defaults"]["properties"]

    assert "model" in defaults
    assert "effort" not in defaults


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
