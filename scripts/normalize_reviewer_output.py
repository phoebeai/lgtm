from __future__ import annotations

import json
import os

from scripts.shared.github_output import write_github_output
from scripts.shared.reviewer_core import (
    as_bool,
    is_non_empty_string,
    is_valid_reviewer_id,
    make_base_payload,
    make_error_payload,
    normalize_reviewer,
    normalize_structured_reviewer_payload,
)
from scripts.shared.types import ReviewerReport


def process_reviewer_output(
    *,
    reviewer: str,
    reviewer_active: str,
    reviewer_has_inputs: str,
    prompt_step_outcome: str,
    prompt_step_conclusion: str,
    prompt_skip_reason: str,
    raw_output: str,
    step_outcome: str,
    step_conclusion: str,
    step_error: str,
) -> ReviewerReport:
    expected_reviewer = normalize_reviewer(reviewer, "")
    if not is_valid_reviewer_id(expected_reviewer):
        raise ValueError("REVIEWER must match ^[a-z0-9_]+$")

    is_active = as_bool(reviewer_active)
    has_inputs = True if reviewer_has_inputs in ("", None) else as_bool(reviewer_has_inputs)

    normalized_prompt_step_outcome = (prompt_step_outcome or "success")
    normalized_prompt_step_conclusion = prompt_step_conclusion or ""
    normalized_prompt_skip_reason = (prompt_skip_reason or "").strip()
    normalized_raw_output = (raw_output or "").strip()
    normalized_step_outcome = step_outcome or ""
    normalized_step_conclusion = step_conclusion or ""
    normalized_step_error = (step_error or "").strip()

    if not is_active:
        return make_base_payload(
            reviewer=expected_reviewer,
            run_state="skipped",
            summary="Skipped (no relevant changes)",
            resolved_finding_ids=[],
            new_findings=[],
            errors=[],
        )

    if normalized_prompt_step_outcome != "success":
        reasons = ["trusted reviewer input build failed"]
        if is_non_empty_string(normalized_prompt_step_outcome):
            reasons.append(f"prompt step outcome: {normalized_prompt_step_outcome}")
        if is_non_empty_string(normalized_prompt_step_conclusion):
            reasons.append(f"prompt step conclusion: {normalized_prompt_step_conclusion}")
        if is_non_empty_string(normalized_prompt_skip_reason):
            reasons.append(f"prompt step note: {normalized_prompt_skip_reason}")
        return make_error_payload(expected_reviewer, reasons)

    if not has_inputs:
        summary = (
            f"Skipped ({normalized_prompt_skip_reason})"
            if is_non_empty_string(normalized_prompt_skip_reason)
            else "Skipped (no relevant changes)"
        )
        return make_base_payload(
            reviewer=expected_reviewer,
            run_state="skipped",
            summary=summary,
            resolved_finding_ids=[],
            new_findings=[],
            errors=[],
        )

    if not normalized_raw_output:
        reasons = ["review output was empty"]
        if is_non_empty_string(normalized_step_error):
            reasons.append(f"review step error: {normalized_step_error}")
        if is_non_empty_string(normalized_step_outcome):
            reasons.append(f"review step outcome: {normalized_step_outcome}")
        if is_non_empty_string(normalized_step_conclusion):
            reasons.append(f"review step conclusion: {normalized_step_conclusion}")
        return make_error_payload(expected_reviewer, reasons)

    try:
        parsed_payload = json.loads(normalized_raw_output)
        if not isinstance(parsed_payload, dict):
            raise ValueError("payload is not a JSON object")

        return normalize_structured_reviewer_payload(parsed_payload, expected_reviewer)
    except Exception as error:
        reasons = [f"invalid review output: {error}"]
        compact_output = " ".join(normalized_raw_output.split())
        preview_head = compact_output[:800]
        preview_tail = compact_output[-800:]

        if preview_head:
            reasons.append(f"review output preview (head): {preview_head}")
        if preview_tail and preview_tail != preview_head:
            reasons.append(f"review output preview (tail): {preview_tail}")
        if is_non_empty_string(normalized_step_outcome):
            reasons.append(f"review step outcome: {normalized_step_outcome}")
        if is_non_empty_string(normalized_step_conclusion):
            reasons.append(f"review step conclusion: {normalized_step_conclusion}")
        if is_non_empty_string(normalized_step_error):
            reasons.append(f"review step error: {normalized_step_error}")

        return make_error_payload(expected_reviewer, reasons)


def main() -> None:
    payload = process_reviewer_output(
        reviewer=os.getenv("REVIEWER", ""),
        reviewer_active=os.getenv("REVIEWER_ACTIVE", ""),
        reviewer_has_inputs=os.getenv("REVIEWER_HAS_INPUTS", ""),
        prompt_step_outcome=os.getenv("PROMPT_STEP_OUTCOME", ""),
        prompt_step_conclusion=os.getenv("PROMPT_STEP_CONCLUSION", ""),
        prompt_skip_reason=os.getenv("PROMPT_SKIP_REASON", ""),
        raw_output=os.getenv("RAW_OUTPUT", ""),
        step_outcome=os.getenv("REVIEW_STEP_OUTCOME", ""),
        step_conclusion=os.getenv("REVIEW_STEP_CONCLUSION", ""),
        step_error=os.getenv("REVIEW_STEP_ERROR", ""),
    )

    serialized = json.dumps(payload)
    write_github_output("report_json", serialized, os.getenv("GITHUB_OUTPUT"))
    print(serialized)


if __name__ == "__main__":
    main()
