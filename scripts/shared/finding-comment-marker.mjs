#!/usr/bin/env node

import { createHmac, timingSafeEqual } from "node:crypto";

export const INLINE_FINDING_MARKER_REGEX = /<!--\s*codex-inline-finding\s+sig=([a-f0-9]{64})\s*-->/i;
const INLINE_FINDING_MARKER_LINE_REGEX = /^<!--\s*codex-inline-finding\s+sig=[a-f0-9]{64}\s*-->$/gim;

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function normalizeHex(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function stripInlineFindingMarkers(value) {
  return normalizeText(value).replace(INLINE_FINDING_MARKER_LINE_REGEX, "");
}

export function normalizeInlineFindingCommentBody(value) {
  return stripInlineFindingMarkers(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractInlineFindingSignature(value) {
  const match = normalizeText(value).match(INLINE_FINDING_MARKER_REGEX);
  return match?.[1] ? normalizeHex(match[1]) : "";
}

export function hasInlineFindingMarker(value) {
  return extractInlineFindingSignature(value).length > 0;
}

export function signInlineFindingBody({ body, secret }) {
  const normalizedSecret = String(secret ?? "");
  if (!normalizedSecret) return "";
  const normalizedBody = normalizeInlineFindingCommentBody(body);
  return createHmac("sha256", normalizedSecret).update(normalizedBody).digest("hex");
}

export function buildInlineFindingMarker({ body, secret }) {
  const signature = signInlineFindingBody({ body, secret });
  if (!signature) return "";
  return `<!-- codex-inline-finding sig=${signature} -->`;
}

function safeEqualHex(left, right) {
  const leftBuffer = Buffer.from(normalizeHex(left), "utf8");
  const rightBuffer = Buffer.from(normalizeHex(right), "utf8");
  if (leftBuffer.length === 0 || rightBuffer.length === 0 || leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyInlineFindingCommentSignature({ body, secret }) {
  const signature = extractInlineFindingSignature(body);
  if (!signature) return false;
  const expected = signInlineFindingBody({ body, secret });
  if (!expected) return false;
  return safeEqualHex(signature, expected);
}
