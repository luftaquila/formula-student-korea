export function createSSEManager(maxClients = 200) {
  const clients = new Set();

  function broadcast(event, data) {
    const safeEvent = String(event).replace(/[\r\n]/g, "");
    const message = `event: ${safeEvent}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        clients.delete(client);
      }
    }
  }

  // Heartbeat to keep connections alive through proxies
  setInterval(() => {
    for (const client of clients) {
      try {
        client.write(": keepalive\n\n");
      } catch {
        clients.delete(client);
      }
    }
  }, 30000).unref();

  function handler(initDataFn) {
    return (req, res) => {
      if (clients.size >= maxClients) {
        return res.status(503).send("연결이 너무 많습니다. 잠시 후 다시 시도해주세요.");
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const initData = initDataFn ? initDataFn(req) : {};
      res.write(`event: init\ndata: ${JSON.stringify(initData)}\n\n`);

      clients.add(res);

      req.on("close", () => {
        clients.delete(res);
      });
    };
  }

  return { broadcast, handler };
}
