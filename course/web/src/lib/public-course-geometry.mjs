export function createPublicCourseGeometry(publish, {
  createWorker = () => new Worker(new URL("./public-course-geometry.worker.mjs", import.meta.url), { type: "module" }),
  onError = () => {},
} = {}) {
  let worker = null;
  let disposed = false;

  function stop() {
    worker?.terminate();
    worker = null;
  }

  function replace(details) {
    stop();
    if (disposed || !Object.keys(details).length) return;
    try {
      const current = worker = createWorker();
      const pending = new Set(Object.keys(details));
      current.onmessage = ({ data: { id, geometry } }) => {
        if (worker !== current || !pending.delete(id)) return;
        publish(id, geometry);
        if (!pending.size) stop();
      };
      current.onerror = (event) => {
        if (worker !== current) return;
        event.preventDefault();
        stop();
        onError();
      };
      // Vue's reactive proxies cannot be sent through structured clone.
      current.postMessage(JSON.parse(JSON.stringify(details)));
    } catch {
      stop();
      onError();
    }
  }

  return { replace, dispose() { disposed = true; stop(); } };
}
