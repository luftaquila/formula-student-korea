const TERMINAL_LOOKUP_STATUSES = new Set([400, 404, 410]);

export function isTerminalLookupError(error) {
  return TERMINAL_LOOKUP_STATUSES.has(Number(error?.status));
}

export function isLookupEntryAvailable(entries, num) {
  const entry = entries?.[String(num)];
  return Boolean(entry) && entry.active !== false;
}
