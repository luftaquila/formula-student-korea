export function healthyWirelessTelemetry(nodeId, extra = {}) {
  return {
    node_id: String(nodeId),
    link_state: "online",
    last_seen_ms: 0,
    rssi: -60,
    snr: 9,
    skew_ppm: 12,
    beacon_gap: 0,
    sec_drop: 0,
    provisioned: 1,
    sync_valid: 1,
    skew_valid: 1,
    clock_source: "xtal",
    sync_age_ms: 100,
    capture_overflow: 0,
    event_drop: 0,
    queue_depth: 0,
    queue_overflow: 0,
    usb_ref_valid: 1,
    usb_ref_ppm: 25,
    ...extra,
  };
}

export function healthyWirelessBatch(sensorIds) {
  const sensors = [...new Set((sensorIds || []).map(String))].filter((node) => node !== "0");
  return {
    telemetry: [
      healthyWirelessTelemetry("0", { skew_ppm: 0, sync_age_ms: 0 }),
      ...sensors.map((node) => healthyWirelessTelemetry(node)),
    ],
  };
}
