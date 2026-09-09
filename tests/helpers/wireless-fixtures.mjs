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

// Deterministic hardware clock for module API tests; production always asks the
// attached master for a fresh capture through the bridge.
export async function readWirelessClock({ start_tick } = {}) {
  return { master_tick: start_tick ?? "0", master_boot_id: 1 };
}

export function wirelessProtocolClient(client, state = { nodes: new Map(), keys: new Map(), packet: 60000, tick: 0n }) {
  const post = client.post;
  return {
    ...client,
    async post(path, options = {}) {
      const body = options.body;
      if (body?.action === "start" && /\/wireless\/arm$/.test(path) && state.nodes.size && /^\d+$/.test(String(body.start_tick ?? 0))) {
        state.tick = BigInt(body.start_tick ?? 0);
        const events = [...state.nodes].map(([node, seq]) => ({ node_id: node, ev_seq: state.packet++ % 65536,
          master_tick: String(state.tick), end_tick: String(state.tick), master_boot_id: 1, sensor_boot_id: 1,
          flags: 47, sync_age_ms: 0, capture_seq: seq, end_seq: seq }));
        await post(path.replace(/arm$/, "ingest"), { ...options, body: { events } });
      }
      if (!body || !/\/wireless\/ingest$/.test(path) || body.rawProtocol) return post(path, options);
      const events = (body.events || []).map(event => {
        const boot = event.master_boot_id ?? 1;
        const key = `${boot}:${event.node_id}:${event.ev_seq}:${event.master_tick}`;
        if (!state.keys.has(key)) {
          const seq = (state.nodes.get(String(event.node_id)) ?? 0) + 1;
          if (boot === 1) state.nodes.set(String(event.node_id), seq);
          state.keys.set(key, seq);
        }
        const seq = event.capture_seq ?? state.keys.get(key);
        if (/^\d+$/.test(String(event.master_tick)) && BigInt(event.master_tick) <= ((1n << 64n) - 1n) && BigInt(event.master_tick) > state.tick) state.tick = BigInt(event.master_tick);
        return { flags: 15, sensor_boot_id: 1, master_boot_id: 1, sync_age_ms: 0,
          capture_seq: seq, end_seq: seq, end_tick: event.master_tick, ...event };
      });
      for (const diagnostic of body.telemetry || []) {
        if (String(diagnostic.node_id) !== "0" && !state.nodes.has(String(diagnostic.node_id))) state.nodes.set(String(diagnostic.node_id), 0);
      }
      if (body.checkpoints !== false) {
        for (const [node, seq] of state.nodes) events.push({ node_id: node, master_tick: String(state.tick),
          ev_seq: state.packet++ % 65536, master_boot_id: 1, sensor_boot_id: 1, flags: 47, sync_age_ms: 0,
          capture_seq: seq, end_seq: seq, end_tick: String(state.tick) });
      }
      return post(path, { ...options, body: { ...body, events } });
    },
  };
}

// Playwright's request context uses `data` where the API fixture uses `body`.
export function wirelessBrowserRequest(request) {
  const protocol = wirelessProtocolClient({ post: (url, { body, ...options }) => request.post(url, { ...options, data: body }) });
  return { post: (url, { data, ...options } = {}) => protocol.post(url, { ...options, body: data }) };
}
