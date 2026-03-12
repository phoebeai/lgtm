from pathlib import Path


def test_lgtm_workflow_uses_uv_and_python_scripts() -> None:
    body = Path(".github/workflows/lgtm.yml").read_text(encoding="utf-8")
    assert "astral-sh/setup-uv" in body
    assert "actions/create-github-app-token@v1" in body
    assert "uv run --project workflow-src python -m scripts.load_trusted_review_config" in body
    assert "python -m scripts.run_reviewers_parallel" in body
    assert "python -m scripts.dismiss_bot_approvals_on_failure" in body
    assert "PYTHONPATH: ${{ github.workspace }}/workflow-src" in body
    assert "node workflow-src/scripts" not in body
    assert "INPUT_EFFORT" not in body
    assert "RESOLVED_EFFORT" not in body
    assert "blocking_findings_count" not in body
    assert "secrets.lgtm_github_app_id" in body
    assert "secrets.lgtm_github_app_private_key" in body
    assert "steps.github_token.outputs.token" in body
    assert "steps.github_token.outputs.app-slug" in body
    assert "steps.config.outputs.max_changed_lines" in body
    assert "id: setup_uv" in body
    assert "lgtm_github_token_prefix" not in body
    assert "lgtm_github_token_part1" not in body
    assert "lgtm_github_token_part2" not in body
    assert "github.token" not in body


def test_dogfood_workflow_uses_reusable_workflow_with_inherited_secrets() -> None:
    body = Path(".github/workflows/dogfood.yml").read_text(encoding="utf-8")
    assert "mint_lgtm_app_token" not in body
    assert "uses: ./.github/workflows/lgtm.yml" in body
    assert "secrets: inherit" in body
    assert "openai_api_key: ${{ secrets.OPENAI_API_KEY }}" not in body
    assert "lgtm_github_app_id: ${{ secrets.LGTM_GITHUB_APP_ID }}" not in body
    assert "lgtm_github_app_private_key: ${{ secrets.LGTM_GITHUB_APP_PRIVATE_KEY }}" not in body
    assert "lgtm_github_token_prefix" not in body
    assert "lgtm_github_token_part1" not in body
    assert "lgtm_github_token_part2" not in body
    assert "github.token" not in body


def test_ci_workflow_runs_python_tooling() -> None:
    body = Path(".github/workflows/ci.yml").read_text(encoding="utf-8")
    assert "uv run pytest" in body
    assert "uv run ruff check" in body
    assert "uv run ty check" in body
    assert "npm test" not in body
