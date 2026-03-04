#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  fetch_lgtm_context.sh [-R owner/repo] [-b branch] [-r run_id] [-d dest_root]

Defaults:
  - repo:   current gh repo (gh repo view)
  - branch: current git branch
  - run_id: latest completed LGTM run on branch
  - dest:   /tmp/lgtm-<run_id>

Output:
  - Downloads lgtm-<run_id> artifact into:
      <dest_root>/lgtm-<run_id>/
  - Prints run metadata, reviewer states, reviewer errors, and blocking findings.
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

REPO=""
BRANCH=""
RUN_ID=""
DEST_ROOT=""

while getopts ":R:b:r:d:h" opt; do
  case "$opt" in
    R) REPO="$OPTARG" ;;
    b) BRANCH="$OPTARG" ;;
    r) RUN_ID="$OPTARG" ;;
    d) DEST_ROOT="$OPTARG" ;;
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
  RUN_ID="$(
    gh run list \
      --workflow LGTM \
      --branch "$BRANCH" \
      --event pull_request \
      --limit 20 \
      -R "$REPO" \
      --json databaseId,status \
      --jq 'map(select(.status == "completed")) | .[0].databaseId // empty'
  )"
fi

if [[ -z "$RUN_ID" ]]; then
  echo "No completed LGTM run found for branch '$BRANCH' in '$REPO'." >&2
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

RUN_URL="$(gh run view "$RUN_ID" -R "$REPO" --json url --jq .url)"

echo "LGTM_REPO=$REPO"
echo "LGTM_BRANCH=$BRANCH"
echo "LGTM_RUN_ID=$RUN_ID"
echo "LGTM_RUN_URL=$RUN_URL"
echo "LGTM_BUNDLE_DIR=$BUNDLE_DIR"
echo "LGTM_MERGED_REPORT=$MERGED_REPORT"
echo

echo "Reviewer states:"
jq -r '
  to_entries[]
  | "- \(.key): \(.value.run_state // "unknown") (findings=\((.value.findings // []) | length), errors=\((.value.errors // []) | length))"
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

echo "Blocking findings:"
BLOCKING_COUNT="$(
  jq '[to_entries[] as $r | ($r.value.findings // [])[]? | select(.blocking == true)] | length' "$MERGED_REPORT"
)"
if [[ "$BLOCKING_COUNT" -eq 0 ]]; then
  echo "- none"
else
  jq -r '
    to_entries[] as $reviewer
    | ($reviewer.value.findings // [])[]?
    | select(.blocking == true)
    | "- [\((.severity // "info") | ascii_upcase)] \($reviewer.key)/\(.id // "unknown-id") \((.file // "-") + (if ((.line | type) == "number" and .line > 0) then ":" + (.line | tostring) else "" end))\n  \(.title // "Untitled finding")\n  Recommendation: \(.recommendation // "No recommendation provided.")"
  ' "$MERGED_REPORT"
fi
