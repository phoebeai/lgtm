from __future__ import annotations

from collections.abc import Callable

from .findings_ledger import apply_inline_comment_metadata
from .github_review_threads import (
    ThreadMetadata,
    backfill_missing_inline_thread_ids,
    build_inline_comment_finding_shape,
    collect_findings_with_inline_comments,
    fetch_review_thread_metadata_by_comment_id,
    format_resolved_status_suffix,
    normalize_comment_id,
    set_finding_thread_resolved,
    update_inline_finding_comment,
)
from .inline_review_comments import (
    build_inline_comment_body,
    is_line_bound_finding,
    publish_inline_finding_comments,
)
from .reviewer_core import normalize_finding_id
from .types import FindingsLedger, LedgerFinding, PresentationEntry


def _normalize_text(value: str | int | float | bool | None) -> str:
    return str("" if value is None else value).replace("\r\n", "\n").strip()


def _to_finding_map(ledger: FindingsLedger) -> dict[str, LedgerFinding]:
    return {finding["id"]: finding for finding in ledger["findings"]}


def sync_inline_finding_lifecycle(
    *,
    ledger: FindingsLedger,
    merged: dict[str, FindingsLedger | list[PresentationEntry]],
    token: str,
    repo: str,
    pr_number: str,
    head_sha: str,
    labels_by_reviewer_id: dict[str, str],
    initial_thread_metadata_by_comment_id: dict[int, ThreadMetadata] | None,
    on_non_fatal_error: Callable[[str, Exception], None] | None,
) -> FindingsLedger:
    current_ledger = ledger
    finding_by_id = _to_finding_map(current_ledger)

    def log_non_fatal(context: str, error: Exception) -> None:
        if on_non_fatal_error:
            on_non_fatal_error(context, error)

    merged_newly_opened = merged.get("newlyOpenedEntries")
    newly_opened_entries = merged_newly_opened if isinstance(merged_newly_opened, list) else []

    newly_line_bound: list[PresentationEntry] = []
    for entry in newly_opened_entries:
        if not is_line_bound_finding(entry["finding"]):
            continue

        finding_id = normalize_finding_id(entry["finding"]["id"])
        existing = finding_by_id.get(finding_id)
        if existing and isinstance(existing["inline_comment_id"], int) and existing["inline_comment_id"] > 0:
            continue

        newly_line_bound.append(entry)

    if newly_line_bound:
        try:
            posted = publish_inline_finding_comments(
                token=token,
                repo=repo,
                pr_number=pr_number,
                head_sha=head_sha,
                entries=newly_line_bound,
                labels_by_reviewer_id=labels_by_reviewer_id,
            )

            if posted["postedEntries"]:
                entries_for_metadata = [
                    {
                        "finding": {"id": entry["finding"]["id"]},
                        "comment_id": entry.get("comment_id"),
                        "comment_url": entry.get("comment_url", ""),
                    }
                    for entry in posted["postedEntries"]
                ]
                current_ledger = apply_inline_comment_metadata(
                    ledger=current_ledger,
                    entries=entries_for_metadata,
                )
                finding_by_id = _to_finding_map(current_ledger)
        except Exception as error:
            log_non_fatal("publishInlineFindingComments", error)

    thread_metadata_by_comment_id = initial_thread_metadata_by_comment_id or {}
    if collect_findings_with_inline_comments(current_ledger):
        try:
            thread_metadata_by_comment_id = fetch_review_thread_metadata_by_comment_id(
                token=token,
                repo=repo,
                pr_number=pr_number,
            )
        except Exception as error:
            log_non_fatal("fetchReviewThreadsForBackfill", error)

        current_ledger = backfill_missing_inline_thread_ids(
            ledger=current_ledger,
            thread_metadata_by_comment_id=thread_metadata_by_comment_id,
        )
        finding_by_id = _to_finding_map(current_ledger)

    merged_newly_resolved = merged.get("newlyResolvedEntries")
    newly_resolved_entries = merged_newly_resolved if isinstance(merged_newly_resolved, list) else []
    for entry in newly_resolved_entries:
        finding_id = normalize_finding_id(entry["finding"]["id"])
        finding = finding_by_id.get(finding_id)
        if finding is None:
            continue

        comment_id = normalize_comment_id(finding["inline_comment_id"])

        thread_resolved = False
        try:
            thread_resolved = set_finding_thread_resolved(
                token=token,
                finding=finding,
                desired_resolved=True,
                thread_metadata_by_comment_id=thread_metadata_by_comment_id,
            )
        except Exception as error:
            log_non_fatal("resolveReviewThread", error)

        if not comment_id or not thread_resolved:
            continue

        reviewer_key = finding["reviewer"]
        reviewer_label = _normalize_text(labels_by_reviewer_id.get(reviewer_key, reviewer_key)) or "Reviewer"
        body = (
            f"{build_inline_comment_body(reviewer_label=reviewer_label, finding=build_inline_comment_finding_shape(finding))}"
            f"\n\n{format_resolved_status_suffix(head_sha)}"
        )
        try:
            update_inline_finding_comment(token=token, repo=repo, comment_id=comment_id, body=body)
        except Exception as error:
            log_non_fatal("updateResolvedInlineComment", error)

    merged_reopened = merged.get("reopenedEntries")
    reopened_entries = merged_reopened if isinstance(merged_reopened, list) else []
    for entry in reopened_entries:
        finding_id = normalize_finding_id(entry["finding"]["id"])
        finding = finding_by_id.get(finding_id)
        if finding is None:
            continue

        comment_id = normalize_comment_id(finding["inline_comment_id"])

        thread_reopened = False
        try:
            thread_reopened = set_finding_thread_resolved(
                token=token,
                finding=finding,
                desired_resolved=False,
                thread_metadata_by_comment_id=thread_metadata_by_comment_id,
            )
        except Exception as error:
            log_non_fatal("unresolveReviewThread", error)

        if not comment_id or not thread_reopened:
            continue

        reviewer_key = finding["reviewer"]
        reviewer_label = _normalize_text(labels_by_reviewer_id.get(reviewer_key, reviewer_key)) or "Reviewer"
        body = build_inline_comment_body(
            reviewer_label=reviewer_label,
            finding=build_inline_comment_finding_shape(finding),
        )
        try:
            update_inline_finding_comment(token=token, repo=repo, comment_id=comment_id, body=body)
        except Exception as error:
            log_non_fatal("updateReopenedInlineComment", error)

    for finding in collect_findings_with_inline_comments(current_ledger):
        comment_id = normalize_comment_id(finding["inline_comment_id"])
        if not comment_id:
            continue

        metadata = thread_metadata_by_comment_id.get(comment_id)
        if metadata is None:
            continue

        should_be_resolved = finding["status"] == "resolved"
        if metadata.is_resolved is should_be_resolved:
            continue

        try:
            set_finding_thread_resolved(
                token=token,
                finding=finding,
                desired_resolved=should_be_resolved,
                thread_metadata_by_comment_id=thread_metadata_by_comment_id,
            )
        except Exception as error:
            context = "reconcileResolveReviewThread" if should_be_resolved else "reconcileUnresolveReviewThread"
            log_non_fatal(context, error)

    return current_ledger
