# Smoke Consumer Template

This directory contains minimal consumer-side templates for calling the reusable LGTM workflow.

Files:

- `pr-checks.yml`: reusable workflow caller (`.github/workflows/pr-checks.yml`)
- `lgtm.yml`: LGTM config (`.github/lgtm.yml`)

## How To Use

1. Copy `pr-checks.yml` to `.github/workflows/pr-checks.yml` in your repository.
2. Copy `lgtm.yml` to `.github/lgtm.yml` in your repository.
3. Add prompt files referenced by `.github/lgtm.yml` under `.github/lgtm/prompts/`.
4. Add `OPENAI_API_KEY` repository secret.

You can start prompt content from `examples/prompts/default/` in this repository.
