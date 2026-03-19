# LGTM

Reusable GitHub Actions workflow for blocker-first pull request review with multiple Codex reviewers.

## What You Get

- Multiple specialized reviewers running in parallel.
- Trusted config and prompts loaded from the PR base revision.
- Findings ledger lifecycle (`open`/`resolved`) persisted as a run artifact.
- Sticky PR summary comment with open/resolved sections and optional inline findings.
- PASS/FAIL gate based on reviewer errors + open findings.
- Optional auto-approval when no findings are open.
- Automatic dismissal of prior LGTM bot approvals when a later run fails.

## Quick Start

1. Add repository secrets:
   - `OPENAI_API_KEY`
   - `LGTM_GITHUB_APP_ID`
   - `LGTM_GITHUB_APP_PRIVATE_KEY`
2. Add `.github/lgtm.yml`:

```yaml
version: 1
defaults:
  model: gpt-5.3-codex
  max_changed_lines: 1000
reviewers:
  - id: security
    display_name: Security
    prompt_file: .github/lgtm/prompts/security.md
    scope: security risk
  - id: code_quality
    display_name: Code Quality
    prompt_file: .github/lgtm/prompts/code-quality.md
    scope: maintainability and correctness
    paths:
      - src/**
```

3. Add reviewer prompt files referenced by config.

Starter prompts are available in `examples/prompts/default/`.

4. Merge the config and prompt files to your default branch first.

5. In a follow-up PR, add `.github/workflows/pr-checks.yml`:

```yaml
name: PR Checks

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  actions: read

jobs:
  lgtm:
    if: >-
      github.event_name == 'pull_request' ||
      github.event_name == 'issue_comment' ||
      github.event_name == 'pull_request_review_comment'
    uses: phoebeai/lgtm/.github/workflows/lgtm.yml@v1
    with:
      caller_event_name: ${{ github.event_name }}
      comment_body: ${{ github.event.comment.body || '' }}
      comment_author_association: ${{ github.event.comment.author_association || '' }}
      comment_user_type: ${{ github.event.comment.user.type || '' }}
      comment_issue_number: ${{ github.event_name == 'issue_comment' && github.event.issue.number || 0 }}
      comment_issue_is_pull_request: ${{ github.event_name == 'issue_comment' && github.event.issue.pull_request != null }}
      comment_review_pr_number: ${{ github.event_name == 'pull_request_review_comment' && github.event.pull_request.number || 0 }}
      config_path: .github/lgtm.yml
      publish_comment: true
      publish_inline_comments: true
      enforce_gate: true
      auto_approve_no_findings: true
    secrets:
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
      lgtm_github_app_id: ${{ secrets.LGTM_GITHUB_APP_ID }}
      lgtm_github_app_private_key: ${{ secrets.LGTM_GITHUB_APP_PRIVATE_KEY }}
```

6. Open or update a PR.

Maintainers can comment `/lgtm rerun` or `/lgtm rerun security` on the PR or on an inline LGTM thread to trigger a fresh run. Reviewer prompts include prior inline-thread replies for existing findings so reruns can resolve findings based on the discussion.

If you add the caller workflow and `.github/lgtm.yml` in the same PR, the first run will fail because trusted config and prompts are loaded from the PR base revision.

## Configuration Schema

Schema: `schemas/lgtm-config.schema.json`

Top-level fields:

- `version` (`1`, required)
- `defaults.model` (optional string)
- `defaults.max_changed_lines` (optional integer, default `1000`)
- `reviewers` (required, non-empty array)

Reviewer fields:

- `id` (required, `^[a-z0-9_]+$`)
- `display_name` (required)
- `prompt_file` (required, relative path, no parent traversal)
- `scope` (required)
- `paths` (optional array of glob patterns)

If the full PR diff exceeds `defaults.max_changed_lines`, excluding files marked generated via `.gitattributes`, LGTM fails before any reviewer runs and requires manual review.

## Workflow Inputs

Inputs exposed by `.github/workflows/lgtm.yml`:

- `workflow_source_repository` (default `phoebeai/lgtm`)
- `workflow_source_ref` (default `v1`)
- `caller_event_name` (optional caller event name for comment-triggered reruns)
- `comment_body` (optional caller comment body)
- `comment_author_association` (optional caller comment author association)
- `comment_user_type` (optional caller comment author type)
- `comment_issue_number` (optional issue number from `issue_comment`)
- `comment_issue_is_pull_request` (optional boolean for `issue_comment` PR context)
- `comment_review_pr_number` (optional PR number from `pull_request_review_comment`)
- `config_path` (default `.github/lgtm.yml`)
- `model` (optional global override)
- `publish_comment` (default `true`)
- `publish_inline_comments` (default `true`)
- `enforce_gate` (default `true`)
- `reviewer_timeout_minutes` (default `10`)
- `auto_approve_no_findings` (default `false`)
- `pull_request_number` (used by `workflow_dispatch` callers)
- `reviewer_filter` (optional reviewer id for targeted reruns)

Secrets:

- `openai_api_key`
- `lgtm_github_app_id`
- `lgtm_github_app_private_key`

GitHub auth:

- LGTM mints a short-lived GitHub App installation token inside the reusable workflow job.
- Caller passes App credentials as secrets:
  - `lgtm_github_app_id: ${{ secrets.LGTM_GITHUB_APP_ID }}`
  - `lgtm_github_app_private_key: ${{ secrets.LGTM_GITHUB_APP_PRIVATE_KEY }}`
- For same-repo trusted callers, you can use `secrets: inherit` instead of explicit mapping.
- Install the GitHub App on the repository with at least:
  - `Pull requests: Read and write`
  - `Contents: Read`
  - `Actions: Read`
- Keep caller workflow permissions:
  - `pull-requests: write`
  - `contents: read`
  - `actions: read`
- To allow bot approvals, enable:
  - `Settings -> Actions -> General -> Allow GitHub Actions to create and approve pull requests`

## Security Model

- Config and prompt files are read from the trusted base commit, not PR head.
- Reviewer scope is limited to files changed in `base...head`.
- Reviewer execution runs in read-only sandbox mode.
- Workflow execution is non-interactive (`approval_policy: never`).
- Prior finding state is loaded from the latest completed LGTM artifact for the PR.

## Fork PR Behavior

On pull requests from forks, repository secrets are typically unavailable. If `OPENAI_API_KEY` or the caller's GitHub App minting secrets are unavailable, this workflow cannot run reviewer execution. Recommended patterns:

- run this workflow only for same-repo PRs, or
- use an internal triage workflow for fork contributions.

## Versioning

Use a tagged release ref in consumers (for example `@v1`). Avoid `@main` in production consumers.

## Examples

- Full example config: `examples/lgtm.yml`
- Starter prompts: `examples/prompts/default/`
- Consumer smoke template: `examples/smoke-consumer/`

## Development

Requirements:

- Python `>=3.12`
- `uv`

Run tests:

```bash
uv sync --all-groups
uv run pytest
uv run ruff check scripts tests
uv run ty check scripts tests
```

## Contributing and Security

- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
