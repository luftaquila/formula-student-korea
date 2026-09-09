import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const sseStub = `
  import { ref } from 'vue';
  export const handlers = new Map();
  export const parseSSEData = (event) => JSON.parse(event.data);
  export const createServiceSSE = () => ({
    on: (name, handler) => handlers.set(name, handler),
    useSSE: () => ({}), reconnected: ref(0),
  });
`;
const stubUrl = new URL('./record-files-sse-stub.mjs', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === stubUrl) return { url: stubUrl, shortCircuit: true };
    if (context.parentURL?.endsWith('/competition/modules/traffic/web/src/composables/useSSE.js')) {
      if (specifier === '@shared/browser/useSSE.js') return { url: stubUrl, shortCircuit: true };
      if (specifier === './useApi') return { url: 'data:text/javascript,export const fetchWirelessEvents = async () => [];', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === stubUrl) return { format: 'module', source: sseStub, shortCircuit: true };
    return nextLoad(url, context);
  },
});

test('record selection uses only server record files on initialization and updates', async () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    const { useSSE } = await import('../../competition/modules/traffic/web/src/composables/useSSE.js');
    const { handlers } = await import(stubUrl);
    const { recordFiles } = useSSE();
    for (const event of ['init', 'records']) {
      for (const files of [[], ['FSK 2026 가속']]) {
        handlers.get(event)({ data: JSON.stringify({ recordFiles: files }) });
        assert.deepEqual(recordFiles.value, files);
      }
    }
  } finally {
    hooks.deregister();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});
