export function createSSEManager() {
  const clients = new Set();

  function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      client.write(message);
    }
  }

  function handler(initDataFn) {
    return (req, res) => {
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

  return { broadcast, handler, clients };
}
