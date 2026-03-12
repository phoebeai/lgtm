from __future__ import annotations

import json
import os
import re
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

from scripts.shared.git_trusted_read import (
    GitRunner,
    default_run_git,
    git_object_exists,
    read_git_blob,
    require_env,
)
from scripts.shared.github_output import write_github_output
from scripts.shared.types import JSONValue, ReviewerConfig

REVIEWER_ID_PATTERN = re.compile(r"^[a-z0-9_]+$")
UNSAFE_PATH_PATTERN = re.compile(r"[\u0000-\u001F\u007F-\u009F\u2028\u2029]")
DEFAULT_MAX_CHANGED_LINES = 1000


def parse_yaml_or_json(input_text: str, source_label: str) -> dict[str, JSONValue]:
    try:
        parsed_json = json.loads(input_text)
        if isinstance(parsed_json, dict):
            return parsed_json
    except json.JSONDecodeError:
        pass

    try:
        parsed_yaml = yaml.safe_load(input_text)
    except yaml.YAMLError as error:
        raise ValueError(
            f"Invalid config in trusted base revision ({source_label}): {error}"
        ) from error

    if not isinstance(parsed_yaml, dict):
        raise ValueError(f"Invalid config in trusted base revision ({source_label}): root must be an object")

    return parsed_yaml


def strip_legacy_reviewer_required(raw_config: dict[str, JSONValue]) -> dict[str, JSONValue]:
    raw_reviewers = raw_config.get("reviewers")
    if not isinstance(raw_reviewers, list):
        return raw_config

    normalized_reviewers: list[JSONValue] = []
    for raw_reviewer in raw_reviewers:
        if not isinstance(raw_reviewer, dict):
            normalized_reviewers.append(raw_reviewer)
            continue

        reviewer = {key: value for key, value in raw_reviewer.items() if key != "required"}
        normalized_reviewers.append(reviewer)

    return {**raw_config, "reviewers": normalized_reviewers}


def strip_legacy_defaults_effort(raw_config: dict[str, JSONValue]) -> dict[str, JSONValue]:
    raw_defaults = raw_config.get("defaults")
    if not isinstance(raw_defaults, dict):
        return raw_config
    if "effort" not in raw_defaults:
        return raw_config

    normalized_defaults = {key: value for key, value in raw_defaults.items() if key != "effort"}
    return {**raw_config, "defaults": normalized_defaults}


def strip_legacy_reviewer_max_changed_lines(raw_config: dict[str, JSONValue]) -> dict[str, JSONValue]:
    raw_reviewers = raw_config.get("reviewers")
    if not isinstance(raw_reviewers, list):
        return raw_config

    normalized_reviewers: list[JSONValue] = []
    for raw_reviewer in raw_reviewers:
        if not isinstance(raw_reviewer, dict):
            normalized_reviewers.append(raw_reviewer)
            continue

        reviewer = {key: value for key, value in raw_reviewer.items() if key != "max_changed_lines"}
        normalized_reviewers.append(reviewer)

    return {**raw_config, "reviewers": normalized_reviewers}


def load_config_schema() -> dict[str, JSONValue]:
    schema_path = Path(__file__).resolve().parent.parent / "schemas" / "lgtm-config.schema.json"
    try:
        parsed = json.loads(schema_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Could not read config schema from {schema_path}: {error}") from error

    if not isinstance(parsed, dict):
        raise ValueError(f"Could not read config schema from {schema_path}: schema root must be object")

    return parsed


def validate_config_against_schema(
    config: dict[str, JSONValue],
    schema: dict[str, JSONValue],
    source_label: str,
) -> None:
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(config), key=lambda error: error.path)
    if not errors:
        return

    reasons: list[str] = []
    for error in errors:
        where = "/" + "/".join(str(part) for part in error.path) if error.path else "/"
        if error.validator == "additionalProperties" and isinstance(error.message, str):
            additional = error.message.split("('")[-1].split("'")[0] if "'" in error.message else "unknown"
            reasons.append(f"{where} unknown key: {additional}")
        else:
            reasons.append(f"{where} {error.message}")

    raise ValueError(f"Config schema validation failed for {source_label}: {'; '.join(reasons)}")


def assert_allowed_keys(value: dict[str, JSONValue], allowed_keys: set[str], context: str) -> None:
    for key in value:
        if key not in allowed_keys:
            raise ValueError(f"{context} contains unknown key: {key}")


def normalize_string(value: JSONValue, context: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{context} must be a string")

    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{context} must be a non-empty string")

    return normalized


def normalize_optional_positive_int(value: JSONValue, context: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{context} must be an integer")
    if value <= 0:
        raise ValueError(f"{context} must be greater than 0")
    return value


def ensure_safe_relative_path(value: JSONValue, context: str) -> str:
    normalized = normalize_string(value, context)

    if UNSAFE_PATH_PATTERN.search(normalized):
        raise ValueError(f"{context} contains unsafe control characters")
    if normalized.startswith("/"):
        raise ValueError(f"{context} must be a relative path")

    segments = normalized.split("/")
    if any(segment == ".." for segment in segments):
        raise ValueError(f"{context} cannot traverse parent directories")

    return normalized


def normalize_reviewers(raw_reviewers: JSONValue) -> list[ReviewerConfig]:
    if not isinstance(raw_reviewers, list):
        raise ValueError("reviewers must be an array")
    if not raw_reviewers:
        raise ValueError("reviewers must contain at least one reviewer entry")

    ids: set[str] = set()
    reviewers: list[ReviewerConfig] = []

    for index, raw_reviewer in enumerate(raw_reviewers):
        label = f"reviewers[{index}]"
        if not isinstance(raw_reviewer, dict):
            raise ValueError(f"{label} must be an object")

        assert_allowed_keys(
            raw_reviewer,
            {"id", "display_name", "prompt_file", "scope", "paths"},
            label,
        )

        reviewer_id = normalize_string(raw_reviewer.get("id"), f"{label}.id")
        if not REVIEWER_ID_PATTERN.fullmatch(reviewer_id):
            raise ValueError(f"{label}.id must match {REVIEWER_ID_PATTERN.pattern}")
        if reviewer_id in ids:
            raise ValueError(f"Duplicate reviewer id: {reviewer_id}")
        ids.add(reviewer_id)

        display_name = normalize_string(raw_reviewer.get("display_name"), f"{label}.display_name")
        prompt_file = ensure_safe_relative_path(raw_reviewer.get("prompt_file"), f"{label}.prompt_file")
        scope = normalize_string(raw_reviewer.get("scope"), f"{label}.scope")

        paths: list[str] = []
        if "paths" in raw_reviewer:
            raw_paths = raw_reviewer.get("paths")
            if not isinstance(raw_paths, list):
                raise ValueError(f"{label}.paths must be an array when provided")
            for path_index, path_entry in enumerate(raw_paths):
                paths.append(ensure_safe_relative_path(path_entry, f"{label}.paths[{path_index}]"))

        reviewers.append(
            ReviewerConfig(
                id=reviewer_id,
                display_name=display_name,
                prompt_file=prompt_file,
                scope=scope,
                paths_json=json.dumps(paths),
            )
        )

    return reviewers


def normalize_config(raw_config: dict[str, JSONValue]) -> dict[str, JSONValue]:
    assert_allowed_keys(raw_config, {"version", "defaults", "reviewers"}, "config")

    if raw_config.get("version") != 1:
        raise ValueError("config.version must be exactly 1")

    defaults: dict[str, JSONValue]
    raw_defaults = raw_config.get("defaults")
    if raw_defaults is not None:
        if not isinstance(raw_defaults, dict):
            raise ValueError("defaults must be an object when provided")
        assert_allowed_keys(raw_defaults, {"model", "max_changed_lines"}, "defaults")

        model_value = raw_defaults.get("model")
        max_changed_lines_value = normalize_optional_positive_int(
            raw_defaults.get("max_changed_lines"),
            "defaults.max_changed_lines",
        )
        default_max_changed_lines = max_changed_lines_value or DEFAULT_MAX_CHANGED_LINES

        defaults = {
            "model": normalize_string(model_value, "defaults.model") if model_value is not None else "",
            "max_changed_lines": default_max_changed_lines,
        }
    else:
        default_max_changed_lines = DEFAULT_MAX_CHANGED_LINES
        defaults = {"model": "", "max_changed_lines": default_max_changed_lines}

    reviewers = normalize_reviewers(raw_config.get("reviewers"))

    return {
        "version": 1,
        "defaults": defaults,
        "reviewers": reviewers,
    }


def resolve_value_with_fallback(
    *,
    input_value: str,
    config_default: str,
    fallback_value: str,
    field_name: str,
) -> str:
    trimmed_input = input_value.strip()
    if trimmed_input:
        return trimmed_input

    trimmed_config_default = config_default.strip()
    if trimmed_config_default:
        return trimmed_config_default

    trimmed_fallback = fallback_value.strip()
    if not trimmed_fallback:
        raise ValueError(f"Missing fallback {field_name}; set {field_name} input or defaults.{field_name}")

    return trimmed_fallback


def load_trusted_review_config(
    *,
    base_sha: str,
    head_sha: str,
    config_rel: str,
    input_model: str,
    fallback_model: str,
    run_git: GitRunner = default_run_git,
) -> tuple[str, str, str]:
    normalized_base_sha = require_env("BASE_SHA", base_sha)
    normalized_head_sha = require_env("HEAD_SHA", head_sha)
    normalized_config_rel = ensure_safe_relative_path(config_rel, "CONFIG_REL")

    if not git_object_exists(f"{normalized_base_sha}^{{commit}}", run_git):
        raise ValueError(f"Missing base commit in checkout: {normalized_base_sha}")

    if not git_object_exists(f"{normalized_head_sha}^{{commit}}", run_git):
        raise ValueError(f"Missing head commit in checkout: {normalized_head_sha}")

    if not git_object_exists(f"{normalized_base_sha}:{normalized_config_rel}", run_git):
        raise ValueError(f"Missing trusted config in base revision: {normalized_base_sha}:{normalized_config_rel}")

    raw_config = read_git_blob(
        f"{normalized_base_sha}:{normalized_config_rel}",
        "trusted review config in base revision",
        run_git,
    )

    parsed = parse_yaml_or_json(raw_config, f"{normalized_base_sha}:{normalized_config_rel}")
    parsed = strip_legacy_reviewer_required(parsed)
    parsed = strip_legacy_defaults_effort(parsed)
    parsed = strip_legacy_reviewer_max_changed_lines(parsed)
    validate_config_against_schema(parsed, load_config_schema(), f"{normalized_base_sha}:{normalized_config_rel}")
    config = normalize_config(parsed)

    reviewers = config.get("reviewers")
    assert isinstance(reviewers, list)
    for reviewer in reviewers:
        assert isinstance(reviewer, dict)
        prompt_file = reviewer.get("prompt_file")
        if not isinstance(prompt_file, str):
            raise ValueError("reviewer.prompt_file must be a string")

        if not git_object_exists(f"{normalized_base_sha}:{prompt_file}", run_git):
            raise ValueError(
                f"Missing trusted reviewer prompt in base revision: {normalized_base_sha}:{prompt_file}"
            )

    defaults = config.get("defaults")
    if not isinstance(defaults, dict):
        defaults = {}
    max_changed_lines = normalize_optional_positive_int(
        defaults.get("max_changed_lines"),
        "defaults.max_changed_lines",
    )
    if max_changed_lines is None:
        raise ValueError("defaults.max_changed_lines must be present after normalization")

    resolved_model = resolve_value_with_fallback(
        input_value=input_model,
        config_default=str(defaults.get("model", "")),
        fallback_value=fallback_model,
        field_name="model",
    )

    reviewers_json = json.dumps(reviewers)
    return reviewers_json, resolved_model, str(max_changed_lines)


def main() -> None:
    reviewers_json, resolved_model, max_changed_lines = load_trusted_review_config(
        base_sha=os.getenv("BASE_SHA", ""),
        head_sha=os.getenv("HEAD_SHA", ""),
        config_rel=os.getenv("CONFIG_REL", ""),
        input_model=os.getenv("INPUT_MODEL", ""),
        fallback_model=os.getenv("FALLBACK_MODEL", ""),
    )

    output_path = os.getenv("GITHUB_OUTPUT")
    write_github_output("reviewers_json", reviewers_json, output_path)
    write_github_output("resolved_model", resolved_model, output_path)
    write_github_output("max_changed_lines", max_changed_lines, output_path)

    print(
        json.dumps(
            {
                "reviewer_count": len(json.loads(reviewers_json)),
                "resolved_model": resolved_model,
                "max_changed_lines": max_changed_lines,
            }
        )
    )


if __name__ == "__main__":
    main()
