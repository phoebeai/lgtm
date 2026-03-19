from __future__ import annotations

from typing import TypeAlias, TypedDict

JSONScalar: TypeAlias = str | int | float | bool | None
JSONValue: TypeAlias = JSONScalar | dict[str, "JSONValue"] | list["JSONValue"]
JSONObject: TypeAlias = dict[str, JSONValue]
JSONArray: TypeAlias = list[JSONValue]


class ReviewerConfig(TypedDict):
    id: str
    display_name: str
    prompt_file: str
    scope: str
    paths_json: str


class ConsensusReviewer(TypedDict):
    id: str
    display_name: str


class Finding(TypedDict):
    title: str
    file: str | None
    line: int | None
    recommendation: str
    reopen_finding_id: str | None


class ReviewerReport(TypedDict):
    reviewer: str
    run_state: str
    summary: str
    resolved_finding_ids: list[str]
    new_findings: list[Finding]
    errors: list[str]


class PresentationFinding(TypedDict):
    id: str
    title: str
    recommendation: str
    file: str | None
    line: int | None


class PresentationEntry(TypedDict):
    reviewer: str
    status: str
    finding: PresentationFinding


class LedgerFinding(TypedDict):
    id: str
    reviewer: str
    status: str
    title: str
    recommendation: str
    file: str | None
    line: int | None
    created_run_id: str
    created_at: str
    updated_run_id: str
    updated_at: str
    resolved_at: str | None
    inline_comment_id: int | None
    inline_comment_url: str
    inline_thread_id: str


class FindingsLedger(TypedDict):
    version: int
    findings: list[LedgerFinding]


class ReviewThreadComment(TypedDict):
    comment_id: int | None
    author: str
    body: str
    created_at: str
    url: str


class FindingThreadContext(TypedDict):
    finding_id: str
    thread_id: str
    thread_resolved: bool
    comments: list[ReviewThreadComment]


class InlineCommentEntry(TypedDict, total=False):
    reviewer: str
    status: str
    finding: PresentationFinding
    comment_id: int | None
    comment_url: str
    inline_thread_id: str
    error: str


class PublishedInlineComments(TypedDict):
    attemptedCount: int
    postedCount: int
    failedCount: int
    postedEntries: list[InlineCommentEntry]
    failedEntries: list[InlineCommentEntry]


class ConsensusResult(TypedDict):
    activeReviewers: list[ConsensusReviewer]
    reviewerErrors: list[str]
    reviewerNewFindings: list[PresentationEntry]
    failureReasons: list[str]
    outcome: str
