# Smoke Consumer Template

This directory contains minimal consumer-side templates for calling the reusable LGTM workflow.

Files:

- `pr-checks.yml`: reusable workflow caller (`.github/workflows/pr-checks.yml`)
- `lgtm.yml`: LGTM config (`.github/lgtm.yml`)

## How To Use

1. Copy `lgtm.yml` to `.github/lgtm.yml` in your repository.
2. Add prompt files referenced by `.github/lgtm.yml` under `.github/lgtm/prompts/`.
3. Add repository secrets:
   - `OPENAI_API_KEY`
   - `LGTM_GITHUB_APP_ID`
   - `LGTM_GITHUB_APP_PRIVATE_KEY`
4. Merge this setup to your default branch.
5. In a follow-up PR, copy `pr-checks.yml` to `.github/workflows/pr-checks.yml`.

Token permissions:

- LGTM uses a GitHub App installation token minted inside the reusable workflow.
- Pass App secrets in the caller:
  - `github_app_id: ${{ secrets.LGTM_GITHUB_APP_ID }}`
  - `github_app_private_key: ${{ secrets.LGTM_GITHUB_APP_PRIVATE_KEY }}`
- Install the App on your repository with:
  - `Pull requests: Read and write`
  - `Contents: Read`
  - `Actions: Read`
- Keep `permissions` in `pr-checks.yml`:
  - `pull-requests: write`
  - `contents: read`
  - `actions: read`
- If you want LGTM to auto-approve clean PRs, set `with.auto_approve_no_findings: true` and enable
  `Actions -> General -> Allow GitHub Actions to create and approve pull requests`.

You can start prompt content from `examples/prompts/default/` in this repository.

If you enable `pr-checks.yml` in the same PR that introduces `.github/lgtm.yml`, the first run will fail because LGTM reads trusted config and prompts from the base revision.
