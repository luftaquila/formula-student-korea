export const SKIDPAD_EVENT_TYPE = "스키드패드";

/**
 * Return the time used for event scoring, including configured penalties.
 *
 * Traffic keeps the skidpad result as the measured lap 2 + lap 4 sum. The
 * Formula rules score the average of those laps, while cone penalties from
 * every lap are added after taking that average.
 */
export function calculateAdjustedResult(eventType, record, penalty = {}) {
  if (!record || record.status || record.result == null) return null;

  const measuredResult = Number(record.result);
  const scoringResult = eventType === SKIDPAD_EVENT_TYPE
    ? measuredResult / 2
    : measuredResult;

  return scoringResult
    + (Number(record.cones) || 0) * (Number(penalty.cone_penalty) || 0) * 1000
    + (Number(record.oc) || 0) * (Number(penalty.oc_penalty) || 0) * 1000;
}
