# Smoke Consumer Template

This directory contains minimal consumer-side templates for calling the reusable LGTM workflow.

Files:

- `pr-checks.yml`: reusable workflow caller (`.github/workflows/pr-checks.yml`)
- `lgtm.yml`: LGTM config (`.github/lgtm.yml`)

## How To Use

1. Copy `lgtm.yml` to `.github/lgtm.yml` in your repository.
2. Add prompt files referenced by `.github/lgtm.yml` under `.github/lgtm/prompts/`.
3. Add `OPENAI_API_KEY` repository secret.
4. Merge this setup to your default branch.
5. In a follow-up PR, copy `pr-checks.yml` to `.github/workflows/pr-checks.yml` (includes `pull_request_review` triggers so approval bypass status refreshes immediately).

You can start prompt content from `examples/prompts/default/` in this repository.

If you enable `pr-checks.yml` in the same PR that introduces `.github/lgtm.yml`, the first run will fail because LGTM reads trusted config and prompts from the base revision.
