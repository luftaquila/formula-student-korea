// Radio v9 uses the existing reliable EVENT delivery for capture-loss ranges
// and checkpoints. A checkpoint covers only captures already handed off ahead
// of it. Latest-value diagnostics cannot establish this completeness contract.
export const CAPTURE_HEALTH = 15;
export const CAPTURE_LOSS = 16;
export const CAPTURE_CHECKPOINT = 32;
export const CAPTURE_TIME_UNKNOWN = 64;
export const WIRELESS_PROTOCOL_VERSION = 9;
const distance = (seq, baseline) => (seq - baseline) >>> 0;
const tick = row => BigInt(row.master_tick);

export function verifyCaptures(run, rows) {
  const boundary = BigInt(run.boundaryTick);
  const captures = [];
  let through = null;
  let fault = null;
  let faultTick = null;
  let sessionEnded = false;
  function fail(node, at, reason) {
    if (faultTick == null || at < faultTick || (at === faultTick && node < fault.node_id)) {
      faultTick = at;
      fault = { node_id: node, reason };
    }
  }
  for (const row of rows) {
    if (row.node_id === "0" && row.master_boot_id === run.masterBootId && (row.flags & CAPTURE_LOSS) && tick(row) >= boundary) {
      sessionEnded = true;
      fail("0", tick(row), "마스터 기준 시계가 계측 중 변경되었습니다.");
    }
  }
  for (const [node, source] of Object.entries(run.nodes)) {
    const events = rows.filter(row => row.node_id === node && row.master_boot_id === run.masterBootId);
    const ordered = events.filter(row => row.sensor_boot_id === source.boot
      && distance(row.capture_seq, source.seq) < 0x80000000)
      .sort((a, b) => distance(a.capture_seq, source.seq) - distance(b.capture_seq, source.seq)
        || Number(!!(a.flags & CAPTURE_CHECKPOINT)) - Number(!!(b.flags & CAPTURE_CHECKPOINT))
        || Number(!!(a.flags & CAPTURE_LOSS)) - Number(!!(b.flags & CAPTURE_LOSS))
        || (tick(a) < tick(b) ? -1 : tick(a) > tick(b) ? 1 : 0));
    const delivered = ordered.filter(row => !(row.flags & (CAPTURE_LOSS | CAPTURE_CHECKPOINT)));
    let pendingFault = null;
    let previousTick = null;
    const seen = new Set();
    let next = 1;
    let confirmed = boundary - 1n;
    for (const row of ordered) {
      const seq = distance(row.capture_seq, source.seq);
      const at = tick(row);
      if (row.flags & CAPTURE_CHECKPOINT) {
        if (seq === next - 1 && (row.flags & CAPTURE_HEALTH) === CAPTURE_HEALTH && row.sync_age_ms <= 7000) {
          if (at > confirmed) confirmed = at;
          if (pendingFault != null) fail(node, pendingFault, `${node} 센서 캡처가 유실되었거나 캡처 시각을 검증할 수 없습니다.`);
        }
        continue;
      }
      const loss = !!(row.flags & CAPTURE_LOSS);
      const last = loss ? distance(row.end_seq, source.seq) : seq;
      if (loss ? last < next : seq === 0 || seen.has(seq)) continue;
      if (seq > next) break;
      next = Math.max(next, last + 1);
      if (!loss) seen.add(seq);
      const covered = loss && new Set(delivered.filter(item => {
        const position = distance(item.capture_seq, source.seq);
        return position >= seq && position <= last && item.flags === CAPTURE_HEALTH && item.sync_age_ms <= 7000;
      }).map(item => item.capture_seq)).size === last - seq + 1;
      if (loss && covered) continue;
      const backwards = !loss && previousTick != null && at <= previousTick;
      // A reversed timestamp cannot classify its own fault as pre-START.
      const reversalAffectsRun = backwards && previousTick >= boundary;
      if (!loss) previousTick = at;
      if (loss || (row.flags & CAPTURE_HEALTH) !== CAPTURE_HEALTH || row.sync_age_ms > 7000 || backwards) {
        const unknown = !!(row.flags & CAPTURE_TIME_UNKNOWN);
        if (unknown || reversalAffectsRun || BigInt(row.end_tick) >= boundary) {
          const from = unknown ? (confirmed > boundary ? confirmed : boundary) : at < boundary ? boundary : at;
          if (pendingFault == null || from < pendingFault) pendingFault = from;
        }
      } else if (!loss && at >= boundary) captures.push({ ...row, role: source.role });
    }
    if (events.some(row => row.sensor_boot_id !== source.boot && (row.flags & CAPTURE_CHECKPOINT) && tick(row) >= boundary)) {
      sessionEnded = true;
      fail(node, confirmed > boundary ? confirmed : boundary, `${node} 센서가 계측 중 재부팅되었습니다.`);
    }
    if (through == null || confirmed < through) through = confirmed;
  }
  const events = captures.filter(row => tick(row) <= through && (faultTick == null || tick(row) < faultTick))
    .sort((a, b) => tick(a) < tick(b) ? -1 : tick(a) > tick(b) ? 1 : a.node_id.localeCompare(b.node_id));
  return { events, throughTick: String(through ?? boundary - 1n),
    fault: sessionEnded || (through != null && faultTick != null && through >= faultTick) ? fault : null };
}
