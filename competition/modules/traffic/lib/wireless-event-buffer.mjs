// SSE may deliver an edge before the clock response establishes its run.
// Keep a bounded recent window independently of the SSE reconnect cursor.
export function createWirelessEventBuffer(capacity = 4096) {
  const events = new Map();
  const deliveries = new Map();
  return {
    add(event) {
      if (!Number.isSafeInteger(event.id) || event.id <= 0) return;
      events.set(event.id, event);
      while (events.size > capacity) {
        const oldest = events.keys().next().value;
        events.delete(oldest);
        for (const delivery of deliveries.values()) delivery.ids.delete(oldest);
      }
    },
    replay(session, deliver) {
      if (!session?.armed || !session.run_id || session.start_tick == null) return;
      let delivery = deliveries.get(session.event_type);
      if (delivery?.runId !== session.run_id) {
        delivery = { runId: session.run_id, ids: new Set() };
        deliveries.set(session.event_type, delivery);
      }
      for (const event of events.values()) {
        if (delivery.ids.has(event.id) || event.master_boot_id !== session.master_boot_id
          || BigInt(event.master_tick) < BigInt(session.start_tick)) continue;
        delivery.ids.add(event.id);
        deliver(event);
      }
    },
  };
}
