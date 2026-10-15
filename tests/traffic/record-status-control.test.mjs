import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import * as Vue from "vue";

const file = new URL("../../competition/modules/traffic/web/src/components/RecordStatusControl.vue", import.meta.url);
const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file.pathname });
// Bind the compiled component to this test's Vue instance so the custom renderer drives it.
const code = compileScript(descriptor, { id: "record-status-control", inlineTemplate: true }).content
  .replace(/from ["']vue["']/g, `from ${JSON.stringify(import.meta.resolve("vue"))}`);
const { default: RecordStatusControl } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

function mount(props, { confirm = () => true } = {}) {
  const emitted = [];
  const prompts = [];
  const renderer = Vue.createRenderer({
    createElement: (type) => ({ type, children: [], props: {} }),
    createText: (text) => ({ text }), createComment: () => ({}),
    insert(node, parent) { parent.children.push(node); node.parent = parent; },
    remove() {}, setText() {}, setElementText() {},
    parentNode: (node) => node.parent, nextSibling: () => null,
    patchProp(node, key, old, value) { node.props[key] = value; },
  });
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: (message) => { prompts.push(message); return confirm(); } };
  const app = renderer.createApp({
    render: () => Vue.h(RecordStatusControl, {
      ...props,
      onSelect: (status) => emitted.push(["select", status]),
      onCancel: () => emitted.push(["cancel"]),
    }),
  });
  const root = { children: [] };
  app.mount(root);
  const all = (node) => [node, ...(node.children || []).flatMap(all)];
  const buttons = all(root).filter((node) => node.type === "button");
  return {
    emitted, prompts, buttons,
    click: (status) => buttons.find((node) => node.props["data-status"] === status).props.onClick(),
    unmount() {
      app.unmount();
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test("offers only the special verdicts and shows normal as none pressed", () => {
  const c = mount({ status: null, result: 1234, allowCancel: true });
  try {
    assert.deepEqual(c.buttons.map((node) => node.props["data-status"]), ["DNS", "DNF", "DSQ"]);
    assert.deepEqual(c.buttons.map((node) => node.props["aria-pressed"]), [false, false, false]);
  } finally { c.unmount(); }
});

test("selecting an inactive verdict applies it", () => {
  const c = mount({ status: "DNF", result: null, allowCancel: true });
  try {
    c.click("DSQ");
    assert.deepEqual(c.emitted, [["select", "DSQ"]]);
    assert.deepEqual(c.prompts, []);
  } finally { c.unmount(); }
});

test("pressing the active verdict of a timed record restores it to normal", () => {
  const c = mount({ status: "DSQ", result: 1234, allowCancel: true });
  try {
    c.click("DSQ");
    assert.deepEqual(c.emitted, [["select", null]]);
    assert.deepEqual(c.prompts, []);
  } finally { c.unmount(); }
});

test("pressing the active verdict of an untimed record deletes it after confirmation", () => {
  const accepted = mount({ status: "DNF", result: null, allowCancel: true });
  try {
    accepted.click("DNF");
    assert.deepEqual(accepted.emitted, [["cancel"]]);
    assert.equal(accepted.prompts.length, 1);
    assert.match(accepted.prompts[0], /DNF/);
  } finally { accepted.unmount(); }

  const declined = mount({ status: "DNF", result: null, allowCancel: true }, { confirm: () => false });
  try {
    declined.click("DNF");
    assert.deepEqual(declined.emitted, []);
  } finally { declined.unmount(); }
});

test("an unsaved draft clears its verdict without deleting", () => {
  const c = mount({ status: "DNS", result: null });
  try {
    c.click("DNS");
    assert.deepEqual(c.emitted, [["select", null]]);
    assert.deepEqual(c.prompts, []);
  } finally { c.unmount(); }
});

test("disabled and busy controls emit nothing", () => {
  for (const flags of [{ disabled: true }, { busy: true }]) {
    const c = mount({ status: "DNF", result: null, allowCancel: true, ...flags });
    try {
      c.click("DNF");
      c.click("DSQ");
      assert.deepEqual(c.emitted, []);
      assert.deepEqual(c.prompts, []);
    } finally { c.unmount(); }
  }
});
