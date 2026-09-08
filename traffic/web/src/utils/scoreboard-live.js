export function scoreboardRecordFileName(year, eventName) {
  if (!Number.isInteger(year) || typeof eventName !== "string" || !eventName) return null;
  return `FSK ${year} ${eventName}`;
}

export function scoreboardRecordFiles({ persistedFiles, sessions, liveAttempts, year, eventTypes }) {
  const files = new Set((persistedFiles || []).filter((file) => file !== "controller"));
  const allowedTypes = new Set(eventTypes || []);

  for (const session of Object.values(sessions || {})) {
    if (!session?.armed || !allowedTypes.has(session.event_type)) continue;
    const file = scoreboardRecordFileName(year, session.event_name);
    if (file) files.add(file);
  }

  for (const attempt of Object.values(liveAttempts || {})) {
    if (!attempt?.active || !allowedTypes.has(attempt.event_type)) continue;
    const file = scoreboardRecordFileName(year, attempt.event_name);
    if (file) files.add(file);
  }

  return [...files];
}

export function scoreboardElapsedSeconds(clockDisplay) {
  const match = /^(\d+):(\d{2})\.(\d{3})$/.exec(clockDisplay || "");
  if (!match) return "0.000";

  const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
  return seconds.toFixed(3);
}

export function scoreboardElapsedMilliseconds(milliseconds) {
  const elapsed = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  return (elapsed / 1000).toFixed(3);
}

export function scoreboardLiveAttempt({ selectedFile, year, session, timing, records }) {
  if (!session?.armed || !session.run_id || !timing?.start?.timestamp) return null;
  if (scoreboardRecordFileName(year, session.event_name) !== selectedFile) return null;

  const finalizedRecordLoaded = session.saved_record_name === selectedFile
    && session.saved_record_rowid != null
    && (records || []).some((record) => record.rowid === session.saved_record_rowid);
  if (finalizedRecordLoaded) return null;

  return {
    num: session.team?.num ?? null,
    univ: session.team?.univ ?? null,
    team: session.team?.team ?? null,
    elapsedSeconds: scoreboardElapsedSeconds(timing.clockDisplay),
    measuring: true,
  };
}

export function scoreboardSerialLiveAttempt({ selectedFile, year, attempt, now }) {
  if (!attempt?.active || !attempt.attempt_id) return null;
  if (scoreboardRecordFileName(year, attempt.event_name) !== selectedFile) return null;

  const elapsed = Number(attempt.elapsed_ms) + Number(now) - Number(attempt.received_at);
  return {
    num: attempt.team?.num ?? null,
    univ: attempt.team?.univ ?? null,
    team: attempt.team?.team ?? null,
    elapsedSeconds: scoreboardElapsedMilliseconds(elapsed),
    measuring: true,
  };
}
