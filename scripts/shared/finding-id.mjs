#!/usr/bin/env node

function normalizeInline(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function normalizePrefix(value) {
  return normalizeInline(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return 0;
  return parsed;
}

function parseFindingIdParts(value) {
  const compact = value
    .replace(/\s+/g, "")
    .replace(/_/g, "-");
  return (
    /^([A-Z][A-Z0-9]{0,15})-(\d+)$/.exec(compact)
    || /^([A-Z][A-Z0-9]{0,15}?)(\d+)$/.exec(compact)
  );
}

export function normalizeFindingId(value) {
  const raw = normalizeInline(value).toUpperCase();
  if (!raw) return "";

  const match = parseFindingIdParts(raw);
  if (!match) {
    return raw;
  }

  const prefix = normalizePrefix(match[1]);
  const number = parsePositiveInt(match[2]);
  if (!prefix || number <= 0) {
    return raw;
  }

  return `${prefix}${String(number).padStart(3, "0")}`;
}

export function canNormalizeFindingId(value) {
  const raw = normalizeInline(value).toUpperCase();
  if (!raw) return false;
  return Boolean(parseFindingIdParts(raw));
}

export function formatFindingId(prefix, number) {
  const normalizedPrefix = normalizePrefix(prefix);
  const numeric = parsePositiveInt(number);
  if (!normalizedPrefix || numeric <= 0) return "";
  return `${normalizedPrefix}${String(numeric).padStart(3, "0")}`;
}

export function parseFindingIdNumber(id, prefix) {
  const normalizedId = normalizeFindingId(id);
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedId || !normalizedPrefix) return 0;

  const match = new RegExp(`^${normalizedPrefix}(\\d+)$`).exec(normalizedId);
  if (!match) return 0;

  return parsePositiveInt(match[1]);
}
