#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  fetch_lgtm_context.sh [-R owner/repo] [-b branch] [-r run_id] [-d dest_root] [-p pr_number]

Defaults:
  - repo:   current gh repo (gh repo view)
  - branch: current git branch
  - run_id: latest completed run on branch that has non-expired lgtm artifact
  - dest:   /tmp/lgtm-<run_id>
  - pr:     current branch PR number (gh pr view)

Output:
  - Downloads lgtm-<run_id> artifact into:
      <dest_root>/lgtm-<run_id>/
  - Prints run metadata, reviewer states, reviewer errors, open/resolved findings,
    and recent PR comments/replies for steering.
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

run_has_lgtm_artifact() {
  local repo="$1"
  local run_id="$2"
  local artifact_name="lgtm-$run_id"
  local artifact_id

  artifact_id="$(
    gh api "repos/$repo/actions/runs/$run_id/artifacts?per_page=100" \
      --jq ".artifacts[]? | select(.name == \"$artifact_name\" and .expired == false) | .id" \
      2>/dev/null || true
  )"

  [[ -n "$artifact_id" ]]
}

find_latest_lgtm_run_id() {
  local repo="$1"
  local branch="$2"
  local run_ids
  local run_id

  # Preferred when LGTM workflow is directly present.
  run_ids="$(
    gh run list \
      --workflow LGTM \
      --branch "$branch" \
      --limit 50 \
      -R "$repo" \
      --json databaseId,status \
      --jq 'map(select(.status == "completed")) | .[].databaseId' \
      2>/dev/null || true
  )"
  for run_id in $run_ids; do
    if run_has_lgtm_artifact "$repo" "$run_id"; then
      echo "$run_id"
      return 0
    fi
  done

  # Fallback for repos where LGTM runs as a reusable workflow inside another workflow.
  run_ids="$(
    gh run list \
      --branch "$branch" \
      --limit 100 \
      -R "$repo" \
      --json databaseId,status \
      --jq 'map(select(.status == "completed")) | .[].databaseId'
  )"
  for run_id in $run_ids; do
    if run_has_lgtm_artifact "$repo" "$run_id"; then
      echo "$run_id"
      return 0
    fi
  done

  echo ""
}

REPO=""
BRANCH=""
RUN_ID=""
DEST_ROOT=""
PR_NUMBER=""

while getopts ":R:b:r:d:p:h" opt; do
  case "$opt" in
    R) REPO="$OPTARG" ;;
    b) BRANCH="$OPTARG" ;;
    r) RUN_ID="$OPTARG" ;;
    d) DEST_ROOT="$OPTARG" ;;
    p) PR_NUMBER="$OPTARG" ;;
    h)
      usage
      exit 0
      ;;
    :)
      echo "Option -$OPTARG requires an argument." >&2
      usage >&2
      exit 1
      ;;
    \?)
      echo "Invalid option: -$OPTARG" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd gh
require_cmd jq
require_cmd git

if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi

if [[ -z "$BRANCH" ]]; then
  BRANCH="$(git branch --show-current)"
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(find_latest_lgtm_run_id "$REPO" "$BRANCH")"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "No completed run with non-expired lgtm artifact found for branch '$BRANCH' in '$REPO'." >&2
  exit 1
fi

if [[ -z "$DEST_ROOT" ]]; then
  DEST_ROOT="/tmp/lgtm-$RUN_ID"
fi

BUNDLE_DIR="$DEST_ROOT/lgtm-$RUN_ID"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

gh run download "$RUN_ID" -R "$REPO" -n "lgtm-$RUN_ID" -D "$BUNDLE_DIR" >/dev/null

MERGED_REPORT="$BUNDLE_DIR/reports-merged.json"
if [[ ! -f "$MERGED_REPORT" ]]; then
  echo "Downloaded artifact missing reports-merged.json at: $MERGED_REPORT" >&2
  exit 1
fi

LEDGER_REPORT="$BUNDLE_DIR/findings-ledger.json"
if [[ ! -f "$LEDGER_REPORT" ]]; then
  echo "Downloaded artifact missing findings-ledger.json at: $LEDGER_REPORT" >&2
  exit 1
fi

RUN_URL="$(gh run view "$RUN_ID" -R "$REPO" --json url --jq .url)"

if [[ -z "$PR_NUMBER" ]]; then
  PR_NUMBER="$(gh pr view --json number --jq .number 2>/dev/null || true)"
fi

echo "LGTM_REPO=$REPO"
echo "LGTM_BRANCH=$BRANCH"
echo "LGTM_RUN_ID=$RUN_ID"
echo "LGTM_RUN_URL=$RUN_URL"
echo "LGTM_PR_NUMBER=${PR_NUMBER:-unknown}"
echo "LGTM_BUNDLE_DIR=$BUNDLE_DIR"
echo "LGTM_MERGED_REPORT=$MERGED_REPORT"
echo "LGTM_LEDGER_REPORT=$LEDGER_REPORT"
echo

echo "Reviewer states:"
jq -r '
  to_entries[]
  | "- \(.key): \(.value.run_state // "unknown") (new=\((.value.new_findings // .value.findings // []) | length), resolved=\((.value.resolved_finding_ids // []) | length), errors=\((.value.errors // []) | length))"
' "$MERGED_REPORT"
echo

echo "Reviewer errors:"
ERROR_COUNT="$(jq '[to_entries[] | select(.value.run_state == "error")] | length' "$MERGED_REPORT")"
if [[ "$ERROR_COUNT" -eq 0 ]]; then
  echo "- none"
else
  jq -r '
    to_entries[]
    | select(.value.run_state == "error")
    | "- \(.key): \((.value.errors // []) | if length == 0 then "no error details provided" else join(" | ") end)"
  ' "$MERGED_REPORT"
fi
echo

echo "Open findings (gate-driving):"
OPEN_COUNT="$(
  jq '[.findings[]? | select(.status == "open")] | length' "$LEDGER_REPORT"
)"
if [[ "$OPEN_COUNT" -eq 0 ]]; then
  echo "- none"
else
  jq -r '
    .findings[]?
    | select(.status == "open")
    | "- [\(.id // "unknown-id")] \(.reviewer // "unknown-reviewer") \((.file // "-") + (if ((.line | type) == "number" and .line > 0) then ":" + (.line | tostring) else "" end))\n  \(.title // "Untitled finding")\n  Recommendation: \(.recommendation // "No recommendation provided.")"
  ' "$LEDGER_REPORT"
fi
echo

echo "Resolved findings:"
RESOLVED_COUNT="$(
  jq '[.findings[]? | select(.status == "resolved")] | length' "$LEDGER_REPORT"
)"
if [[ "$RESOLVED_COUNT" -eq 0 ]]; then
  echo "- none"
else
  jq -r '
    .findings[]?
    | select(.status == "resolved")
    | "- [\(.id // "unknown-id")] \(.reviewer // "unknown-reviewer") \((.file // "-") + (if ((.line | type) == "number" and .line > 0) then ":" + (.line | tostring) else "" end))\n  \(.title // "Untitled finding")\n  Recommendation: \(.recommendation // "No recommendation provided.")"
  ' "$LEDGER_REPORT"
fi
echo

if [[ -n "$PR_NUMBER" ]]; then
  echo "Recent human PR issue comments (steering):"
  ISSUE_COMMENTS="$(
    gh api "repos/$REPO/issues/$PR_NUMBER/comments?per_page=100" --jq '
      map(select((.user.login | ascii_downcase | endswith("[bot]")) | not))
      | map(select((.body | contains("<!-- lgtm-sticky-comment -->")) | not))
      | sort_by(.updated_at) | reverse | .[:20]
      | .[]
      | "- [\(.updated_at)] @\(.user.login)\n  \((.body | gsub("\r\n"; "\n") | split("\n")[0]))\n  \(.html_url)"
    ' 2>/dev/null || true
  )"
  if [[ -z "$ISSUE_COMMENTS" ]]; then
    echo "- none or unavailable"
  else
    echo "$ISSUE_COMMENTS"
  fi
  echo

  echo "Recent inline PR comments and replies (steering):"
  INLINE_COMMENTS="$(
    gh api "repos/$REPO/pulls/$PR_NUMBER/comments?per_page=100" --jq '
      sort_by(.updated_at) | reverse | .[:40]
      | .[]
      | "- [\(.updated_at)] id=\(.id) reply_to=\(.in_reply_to_id // "-") @\(.user.login) \(.path // "-"):\(.line // "-")\n  \((.body | gsub("\r\n"; "\n") | split("\n")[0]))\n  \(.html_url)"
    ' 2>/dev/null || true
  )"
  if [[ -z "$INLINE_COMMENTS" ]]; then
    echo "- none or unavailable"
  else
    echo "$INLINE_COMMENTS"
  fi
else
  echo "PR comment steering skipped: unable to resolve PR number (use -p <pr_number> to force)."
fi
