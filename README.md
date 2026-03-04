# LGTM

Reusable GitHub Actions workflow for blocker-first pull request review with multiple Codex reviewers.

## What You Get

- Multiple specialized reviewers running in parallel.
- Trusted config and prompts loaded from the PR base revision.
- Findings ledger lifecycle (`open`/`resolved`) persisted as a run artifact.
- Sticky PR summary comment with open/resolved sections and optional inline findings.
- PASS/FAIL gate based on reviewer errors + open findings, with optional human approval bypass.

## Quick Start

1. Add a repository secret named `OPENAI_API_KEY`.
2. Add `.github/lgtm.yml`:

```yaml
version: 1
defaults:
  model: gpt-5.3-codex
  effort: xhigh
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
  pull_request_review:
    types: [submitted, edited, dismissed]

permissions:
  contents: read
  pull-requests: write
  actions: read

jobs:
  lgtm:
    uses: phoebeai/lgtm/.github/workflows/lgtm.yml@v1
    with:
      config_path: .github/lgtm.yml
      publish_comment: true
      publish_inline_comments: true
      enforce_gate: true
    secrets:
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

6. Open or update a PR.

If you add the caller workflow and `.github/lgtm.yml` in the same PR, the first run will fail because trusted config and prompts are loaded from the PR base revision.

## Configuration Schema

Schema: `schemas/lgtm-config.schema.json`

Top-level fields:

- `version` (`1`, required)
- `defaults.model` (optional string)
- `defaults.effort` (optional string)
- `reviewers` (required, non-empty array)

Reviewer fields:

- `id` (required, `^[a-z0-9_]+$`)
- `display_name` (required)
- `prompt_file` (required, relative path, no parent traversal)
- `scope` (required)
- `paths` (optional array of glob patterns)

## Workflow Inputs

Inputs exposed by `.github/workflows/lgtm.yml`:

- `workflow_source_repository` (default `phoebeai/lgtm`)
- `workflow_source_ref` (default `v1`)
- `config_path` (default `.github/lgtm.yml`)
- `model`, `effort` (optional global overrides)
- `publish_comment` (default `true`)
- `publish_inline_comments` (default `true`)
- `enforce_gate` (default `true`)
- `reviewer_timeout_minutes` (default `10`)
- `pull_request_number` (used by `workflow_dispatch` callers)

Required secret:

- `openai_api_key`

## Security Model

- Config and prompt files are read from the trusted base commit, not PR head.
- Reviewer scope is limited to files changed in `base...head`.
- Reviewer execution runs in read-only sandbox mode.
- Workflow execution is non-interactive (`approval_policy: never`).
- Prior finding state is loaded from the latest completed LGTM artifact for the PR.

## Fork PR Behavior

On pull requests from forks, repository secrets are typically unavailable. If `OPENAI_API_KEY` is unavailable, this workflow cannot run reviewer execution. Recommended patterns:

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

- Node.js `>=20`

Run tests:

```bash
npm ci --ignore-scripts
npm test
```

## Contributing and Security

- Contribution guide: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
