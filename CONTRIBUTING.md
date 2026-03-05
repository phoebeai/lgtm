# Contributing

Thanks for contributing to LGTM.

## Development Setup

Requirements:

- Python `>=3.12`
- `uv`

Install dependencies:

```bash
uv sync --all-groups
```

Run tests:

```bash
uv run pytest
uv run ruff check scripts tests
uv run ty check scripts tests
```

## What To Update With Changes

When making runtime or workflow changes, update all affected assets together:

- runtime scripts in `scripts/`
- workflow wiring in `.github/workflows/lgtm.yml`
- schemas in `schemas/`
- docs and examples in `README.md` and `examples/`
- tests in `tests/`

## Testing Expectations

Before opening a PR:

1. Run `uv run pytest`, `uv run ruff check scripts tests`, and `uv run ty check scripts tests`.
2. Ensure example configs remain valid against `schemas/lgtm-config.schema.json`.
3. Keep `README.md` examples aligned with shipped workflow inputs.

## Pull Requests

- Keep PRs focused and explain behavior changes.
- Include tests for new behavior and regressions.
- If you change public workflow inputs/outputs, update docs and examples in the same PR.

## Release Guidance

Consumers should pin workflow refs to a stable tag (for example `v1`).
When behavior changes in a backward-compatible way, move the `v1` tag to the latest release commit.
For breaking changes, publish a new major tag (for example `v2`).
