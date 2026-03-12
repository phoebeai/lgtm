import json

from scripts.normalize_reviewer_output import process_reviewer_output


def _base_process_kwargs(raw_output: str) -> dict[str, str]:
    return {
        "reviewer": "security",
        "reviewer_active": "true",
        "reviewer_has_inputs": "true",
        "prompt_step_outcome": "success",
        "prompt_step_conclusion": "success",
        "prompt_skip_reason": "",
        "raw_output": raw_output,
        "step_outcome": "success",
        "step_conclusion": "success",
        "step_error": "",
    }


def test_process_reviewer_output_accepts_json_object_payload() -> None:
    raw = json.dumps(
        {
            "reviewer": "security",
            "summary": "ok",
            "resolved_finding_ids": [],
            "new_findings": [],
            "errors": [],
        }
    )

    payload = process_reviewer_output(**_base_process_kwargs(raw))

    assert payload["run_state"] == "completed"
    assert payload["summary"] == "ok"


def test_process_reviewer_output_rejects_markdown_wrapped_json() -> None:
    raw = """```json
{"reviewer":"security","summary":"ok","resolved_finding_ids":[],"new_findings":[],"errors":[]}
```"""

    payload = process_reviewer_output(**_base_process_kwargs(raw))

    assert payload["run_state"] == "error"
    assert payload["errors"]
    assert "invalid review output:" in payload["errors"][0]
