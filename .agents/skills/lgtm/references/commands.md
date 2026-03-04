# LGTM Command Reference

Use these when iterating on LGTM failures.

## Latest run with LGTM artifact for current branch

```bash
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
BRANCH="$(git branch --show-current)"
for RUN_ID in $(gh run list -R "$REPO" --branch "$BRANCH" --limit 100 --json databaseId,status --jq 'map(select(.status=="completed")) | .[].databaseId'); do
  HAS_ARTIFACT="$(gh api "repos/$REPO/actions/runs/$RUN_ID/artifacts?per_page=100" --jq ".artifacts[]? | select(.name == \"lgtm-$RUN_ID\" and .expired == false) | .id" 2>/dev/null || true)"
  if [[ -n "$HAS_ARTIFACT" ]]; then
    gh run view "$RUN_ID" -R "$REPO" --json databaseId,workflowName,event,status,conclusion,url --jq '"\(.databaseId)\t\(.workflowName)\t\(.event)\t\(.status)/\(.conclusion)\t\(.url)"'
    break
  fi
done
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
  | "\(.key)\t\(.value.run_state // "unknown")\tnew=\((.value.new_findings // [])|length)\tresolved=\((.value.resolved_finding_ids // [])|length)\terrors=\((.value.errors // [])|length)"
' /tmp/lgtm-<run-id>/lgtm-<run-id>/reports-merged.json
```

## Show open findings only (gate-driving)

```bash
jq -r '
  (.findings // [])[]?
  | select(.status == "open")
  | "\(.reviewer)\t\(.id)\t\(.file // "-"):\((.line // "-"))\t\(.title)"
' /tmp/lgtm-<run-id>/lgtm-<run-id>/findings-ledger.json
```

## Show resolved findings quickly

```bash
jq -r '
  (.findings // [])[]?
  | select(.status == "resolved")
  | "- [\(.id)] \(.reviewer) \((.file // "-") + (if ((.line|type) == "number" and .line > 0) then ":" + (.line|tostring) else "" end))\n  \(.title)\n  Recommendation: \(.recommendation)"
' /tmp/lgtm-<run-id>/lgtm-<run-id>/findings-ledger.json
```

## Pull recent human PR issue comments (steering)

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh api "repos/$REPO/issues/$PR_NUMBER/comments?per_page=100" --jq '
  map(select((.user.login | ascii_downcase | endswith("[bot]")) | not))
  | map(select((.body | contains("<!-- lgtm-sticky-comment -->")) | not))
  | sort_by(.updated_at) | reverse | .[:20]
  | .[]
  | "- [\(.updated_at)] @\(.user.login)\n  \((.body | split("\n")[0]))\n  \(.html_url)"
'
```

## Pull inline PR comments and replies (comment-on-comment steering)

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh api "repos/$REPO/pulls/$PR_NUMBER/comments?per_page=100" --jq '
  sort_by(.updated_at) | reverse | .[:40]
  | .[]
  | "- [\(.updated_at)] id=\(.id) reply_to=\(.in_reply_to_id // "-") @\(.user.login) \(.path // "-"):\(.line // "-")\n  \((.body | split("\n")[0]))\n  \(.html_url)"
'
```
