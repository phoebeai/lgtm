---
name: lgtm
description: Use to consume LGTM workflow output on the current GitHub pull request, download the latest LGTM artifacts, and drive fix loops until LGTM passes. Trigger when asked to check LGTM feedback, handle blocking findings, debug reviewer errors, or iterate on LGTM FAIL outcomes.
---

# LGTM

Use this skill to turn LGTM output into concrete patches quickly and repeatably.

## Workflow

1. Establish PR + LGTM context.

- Run `gh auth status` and ensure auth is valid.
- From the repo root, run:

```bash
bash .agents/skills/lgtm/scripts/fetch_lgtm_context.sh
```

- This downloads the latest completed LGTM artifact for the current branch and prints:
  - run metadata,
  - reviewer run states,
  - reviewer errors,
  - blocking findings with file/line/title/recommendation.

1. Triage in strict order.

- First: reviewer execution/output errors (`run_state=error`) because findings may be incomplete when reviewers fail.
- Second: blocking findings (`blocking: true`).
- Third: advisory findings.

1. Implement targeted fixes.

- Use report file refs as starting points, then verify in code before patching.
- Keep patches tightly scoped to each blocking finding.
- If a finding is a false positive, still leave an evidence trail in PR discussion.

1. Validate and rerun.

- Run targeted tests/lint for touched code.
- Push changes and rerun LGTM; repeat until LGTM is green.

## Direct Commands

Fetch latest completed LGTM run for current branch:

```bash
bash .agents/skills/lgtm/scripts/fetch_lgtm_context.sh
```

Fetch a specific run id:

```bash
bash .agents/skills/lgtm/scripts/fetch_lgtm_context.sh -r 22280357273
```

Read merged JSON in full:

```bash
jq . /tmp/lgtm-<run-id>/lgtm-<run-id>/reports-merged.json
```

List blocking findings only:

```bash
jq -r '
  to_entries[] as $reviewer
  | ($reviewer.value.findings // [])[]?
  | select(.blocking == true)
  | "- [\((.severity // "info") | ascii_upcase)] \($reviewer.key)/\(.id // "unknown-id") \((.file // "-") + (if ((.line|type) == "number" and .line > 0) then ":" + (.line|tostring) else "" end))\n  \(.title // "Untitled finding")\n  Recommendation: \(.recommendation // "No recommendation provided.")"
' /tmp/lgtm-<run-id>/lgtm-<run-id>/reports-merged.json
```

## References

For additional `gh`/`jq` snippets, read:

- `.agents/skills/lgtm/references/commands.md`
