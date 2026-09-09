import assert from "node:assert/strict";

// Exercise the real SSE/HTTP round trip while substituting only the hardware.
// The caller supplies an HTTP request function to share this with Playwright.
export async function withWirelessClock({ url, cookie, respond, tick = "0", boot = 1 }, work) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Cookie: cookie }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const clockResponse = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("Clock stream closed before a request");
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!/^event: wireless:command$/m.test(frame)) continue;
        const command = JSON.parse(frame.match(/^data: (.+)$/m)[1]);
        if (command.action !== "clock") continue;
        return respond({ request_id: command.request_id, master_tick: tick, master_boot_id: boot });
      }
    }
  })();
  try {
    const [result] = await Promise.all([work(), clockResponse]);
    return result;
  } finally {
    await reader.cancel();
    controller.abort();
  }
}
