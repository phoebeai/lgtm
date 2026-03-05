#!/usr/bin/env node

import {
  buildInlineCommentBody,
  isLineBoundFinding,
  publishInlineFindingComments,
} from "./inline-review-comments.mjs";
import { normalizeFindingId } from "./reviewer-core.mjs";
import { applyInlineCommentMetadata } from "./findings-ledger.mjs";
import {
  backfillMissingInlineThreadIds,
  buildInlineCommentFindingShape,
  collectFindingsWithInlineComments,
  fetchReviewThreadMetadataByCommentId,
  formatResolvedStatusSuffix,
  normalizeCommentId,
  setFindingThreadResolved,
  updateInlineFindingComment,
} from "./github-review-threads.mjs";

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function toFindingMap(ledger) {
  const findings = Array.isArray(ledger?.findings) ? ledger.findings : [];
  return new Map(findings.map((finding) => [finding.id, finding]));
}

export async function syncInlineFindingLifecycle({
  ledger,
  merged,
  token,
  repo,
  prNumber,
  headSha,
  labelsByReviewerId,
  initialThreadMetadataByCommentId,
  onNonFatalError,
}) {
  let currentLedger = ledger;
  let findingById = toFindingMap(currentLedger);
  const logNonFatal =
    typeof onNonFatalError === "function"
      ? onNonFatalError
      : () => {};

  const newlyLineBound = (Array.isArray(merged?.newlyOpenedEntries) ? merged.newlyOpenedEntries : []).filter(
    (entry) => {
      if (!isLineBoundFinding(entry?.finding)) return false;
      const findingId = normalizeFindingId(entry?.finding?.id);
      const existing = findingById.get(findingId);
      // Reopened findings should keep using their existing inline comment when available.
      return !(Number.isInteger(existing?.inline_comment_id) && existing.inline_comment_id > 0);
    },
  );

  if (newlyLineBound.length > 0) {
    try {
      const posted = await publishInlineFindingComments({
        token,
        repo,
        prNumber,
        headSha,
        entries: newlyLineBound,
        labelsByReviewerId,
      });

      if (posted.postedEntries.length > 0) {
        currentLedger = applyInlineCommentMetadata({
          ledger: currentLedger,
          entries: posted.postedEntries,
        });
        findingById = toFindingMap(currentLedger);
      }
    } catch (error) {
      logNonFatal("publishInlineFindingComments", error);
    }
  }

  let threadMetadataByCommentId =
    initialThreadMetadataByCommentId instanceof Map
      ? initialThreadMetadataByCommentId
      : new Map();
  if (collectFindingsWithInlineComments(currentLedger).length > 0) {
    try {
      threadMetadataByCommentId = await fetchReviewThreadMetadataByCommentId({
        token,
        repo,
        prNumber,
      });
    } catch (error) {
      logNonFatal("fetchReviewThreadsForBackfill", error);
    }

    currentLedger = backfillMissingInlineThreadIds({
      ledger: currentLedger,
      threadMetadataByCommentId,
    });
    findingById = toFindingMap(currentLedger);
  }

  // Keep inline comment presentation in sync with finding lifecycle transitions.
  for (const entry of Array.isArray(merged?.newlyResolvedEntries) ? merged.newlyResolvedEntries : []) {
    const findingId = normalizeFindingId(entry?.finding?.id);
    const finding = findingById.get(findingId);
    const commentId = normalizeCommentId(finding?.inline_comment_id);

    let threadResolved = false;
    try {
      threadResolved = await setFindingThreadResolved({
        token,
        finding,
        desiredResolved: true,
        threadMetadataByCommentId,
      });
    } catch (error) {
      logNonFatal("resolveReviewThread", error);
    }

    if (!commentId || !threadResolved) continue;
    const reviewerLabel = normalizeText(labelsByReviewerId.get(finding.reviewer) || finding.reviewer || "Reviewer");
    const body = `${buildInlineCommentBody({
      reviewerLabel,
      finding: buildInlineCommentFindingShape(finding),
    })}\n\n${formatResolvedStatusSuffix(headSha)}`;
    try {
      await updateInlineFindingComment({
        token,
        repo,
        commentId,
        body,
      });
    } catch (error) {
      logNonFatal("updateResolvedInlineComment", error);
    }
  }

  for (const entry of Array.isArray(merged?.reopenedEntries) ? merged.reopenedEntries : []) {
    const findingId = normalizeFindingId(entry?.finding?.id);
    const finding = findingById.get(findingId);
    const commentId = normalizeCommentId(finding?.inline_comment_id);

    let threadReopened = false;
    try {
      threadReopened = await setFindingThreadResolved({
        token,
        finding,
        desiredResolved: false,
        threadMetadataByCommentId,
      });
    } catch (error) {
      logNonFatal("unresolveReviewThread", error);
    }

    if (!commentId || !threadReopened) continue;
    const reviewerLabel = normalizeText(labelsByReviewerId.get(finding.reviewer) || finding.reviewer || "Reviewer");
    const body = buildInlineCommentBody({
      reviewerLabel,
      finding: buildInlineCommentFindingShape(finding),
    });
    try {
      await updateInlineFindingComment({
        token,
        repo,
        commentId,
        body,
      });
    } catch (error) {
      logNonFatal("updateReopenedInlineComment", error);
    }
  }

  // Reconcile historical thread state with current ledger status, so old mismatches self-heal.
  for (const finding of collectFindingsWithInlineComments(currentLedger)) {
    const commentId = normalizeCommentId(finding.inline_comment_id);
    if (!commentId) continue;
    const metadata = threadMetadataByCommentId.get(commentId);
    if (!metadata || typeof metadata.isResolved !== "boolean") continue;

    const shouldBeResolved = finding.status === "resolved";
    if (metadata.isResolved === shouldBeResolved) continue;

    try {
      await setFindingThreadResolved({
        token,
        finding,
        desiredResolved: shouldBeResolved,
        threadMetadataByCommentId,
      });
    } catch (error) {
      logNonFatal(
        shouldBeResolved ? "reconcileResolveReviewThread" : "reconcileUnresolveReviewThread",
        error,
      );
    }
  }

  return currentLedger;
}
