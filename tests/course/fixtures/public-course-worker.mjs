// Adapt the browser worker entry point to Node's worker transport for unit tests.
import { parentPort } from "node:worker_threads";
globalThis.self = { postMessage: (data) => parentPort.postMessage(data) };
await import("../../../course/web/src/lib/public-course-geometry.worker.mjs");
parentPort.on("message", (data) => self.onmessage({ data }));
