import pytest

from scripts.shared.reviewers_json import (
    parse_reviewer_ids,
    parse_reviewers_for_consensus,
    parse_reviewers_for_runner,
)


def test_parse_reviewers_for_runner() -> None:
    reviewers = parse_reviewers_for_runner(
        '[{"id":"security","display_name":"Security","prompt_file":"a.md","scope":"risk","max_changed_lines":1000}]'
    )
    assert reviewers[0]["id"] == "security"
    assert reviewers[0]["paths_json"] == "[]"
    assert reviewers[0]["max_changed_lines"] == 1000


def test_parse_reviewers_for_runner_rejects_duplicates() -> None:
    with pytest.raises(ValueError, match="Duplicate reviewer id"):
        parse_reviewers_for_runner(
            '[{"id":"security","prompt_file":"a.md","scope":"risk","max_changed_lines":1000},{"id":"security","prompt_file":"b.md","scope":"risk","max_changed_lines":1000}]'
        )


def test_parse_reviewer_ids_allows_empty() -> None:
    assert parse_reviewer_ids("[]") == []


def test_parse_reviewers_for_consensus_defaults_display_name() -> None:
    reviewers = parse_reviewers_for_consensus('[{"id":"code_quality"}]')
    assert reviewers[0]["display_name"] == "code_quality"
