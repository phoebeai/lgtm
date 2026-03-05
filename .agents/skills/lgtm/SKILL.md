---
name: lgtm
description: Use to consume LGTM workflow output on the current pull request, restore the latest findings ledger artifact, and drive fix loops until LGTM passes. Trigger when asked to check LGTM feedback, handle open findings, debug reviewer errors, or iterate on LGTM FAIL outcomes.
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
  - open/resolved findings from `findings-ledger.json`,
  - recent PR issue comments and inline review replies for steering.

1. Read steering context before coding.

- Pull explicit guidance from:
  - recent human PR issue comments,
  - inline review replies (`in_reply_to_id` chains).
- Treat comments as steering signals. Gate logic still comes from reviewer errors + open ledger findings.

1. Triage in strict order.

- First: reviewer execution/output errors (`run_state=error`) because findings may be incomplete when reviewers fail.
- Second: open findings (`status=open`) from `findings-ledger.json`.
- Third: resolved findings context only when evidence shows a regression/reopen.

1. Implement targeted fixes.

- Use ledger finding IDs (for example `SEC001`) and file refs as anchors, then verify in code before patching.
- Keep patches tightly scoped to each open finding.
- Incorporate explicit maintainer/reviewer steering from PR comment threads where applicable.
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

Read findings ledger in full:

```bash
jq . /tmp/lgtm-<run-id>/lgtm-<run-id>/findings-ledger.json
```

List open findings only:

```bash
jq -r '
  (.findings // [])[]?
  | select(.status == "open")
  | "- [\(.id)] \(.reviewer) \((.file // "-") + (if ((.line|type) == "number" and .line > 0) then ":" + (.line|tostring) else "" end))\n  \(.title)\n  Recommendation: \(.recommendation)"
' /tmp/lgtm-<run-id>/lgtm-<run-id>/findings-ledger.json
```

## References

For additional `gh`/`jq` snippets, read:

- `.agents/skills/lgtm/references/commands.md`
