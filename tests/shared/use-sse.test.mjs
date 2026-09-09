import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer, h, nextTick, ref } from "vue";

import { createSSEConnection } from "../../shared/browser/useSSE.js";

function createTestRenderer() {
  return createRenderer({
    patchProp() {},
    insert(child, parent) {
      parent.children ||= [];
      parent.children.push(child);
      child.parent = parent;
    },
    remove(child) {
      const index = child.parent?.children?.indexOf(child) ?? -1;
      if (index >= 0) child.parent.children.splice(index, 1);
    },
    createElement(type) { return { type, children: [], parent: null }; },
    createText(text) { return { text, parent: null }; },
    createComment(text) { return { comment: text, parent: null }; },
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.text = text; },
    parentNode(node) { return node.parent; },
    nextSibling() { return null; },
  });
}

test("reactive SSE permission starts and stops the connection without leaking subscribers", async () => {
  const previousEventSource = globalThis.EventSource;
  const instances = [];
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      instances.push(this);
    }
    addEventListener() {}
    close() { this.closed = true; }
  }
  globalThis.EventSource = FakeEventSource;

  const enabled = ref(false);
  const connection = createSSEConnection("/inspection/events");
  const renderer = createTestRenderer();
  const app = renderer.createApp({
    setup() {
      connection.useSSE(enabled);
      return () => h("div");
    },
  });

  try {
    app.mount({ children: [] });
    assert.equal(instances.length, 0);

    enabled.value = true;
    await nextTick();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].closed, false);

    enabled.value = false;
    await nextTick();
    assert.equal(instances[0].closed, true);

    enabled.value = true;
    await nextTick();
    assert.equal(instances.length, 2);
    app.unmount();
    assert.equal(instances[1].closed, true);
  } finally {
    app.unmount();
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  }
});
