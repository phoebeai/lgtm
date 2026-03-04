# LGTM Command Reference

Use these when iterating on LGTM failures.

## Latest LGTM run for current branch

```bash
gh run list --workflow LGTM --branch "$(git branch --show-current)" --event pull_request --limit 5 \
  --json databaseId,status,conclusion,url \
  --jq '.[] | "\(.databaseId)\t\(.status)/\(.conclusion)\t\(.url)"'
```

## Download full LGTM artifact bundle

```bash
RUN_ID=<run-id>
gh run download "$RUN_ID" -R "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  -n "lgtm-$RUN_ID" \
  -D "/tmp/lgtm-$RUN_ID/lgtm-$RUN_ID"
```

## Show reviewer run states quickly

```bash
jq -r '
  to_entries[]
  | "\(.key)\t\(.value.run_state // "unknown")\tfindings=\((.value.findings // [])|length)\terrors=\((.value.errors // [])|length)"
' /tmp/lgtm-<run-id>/lgtm-<run-id>/reports-merged.json
```

## Show blocking findings only

```bash
jq -r '
  to_entries[] as $r
  | ($r.value.findings // [])[]?
  | select(.blocking == true)
  | "\($r.key)\t\(.id // "unknown-id")\t\(.severity // "info")\t\(.file // "-"):\((.line // "-"))\t\(.title // "Untitled finding")"
' /tmp/lgtm-<run-id>/lgtm-<run-id>/reports-merged.json
```

## Pull latest sticky LGTM PR comment

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
gh api "repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)/issues/$PR_NUMBER/comments" \
  --jq '[.[] | select(.body|contains("<!-- codex-lgtm -->"))][-1] | .body'
```
