import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import * as Vue from "vue";

const file = new URL("../../competition/modules/traffic/web/src/components/RecordDetailPopup.vue", import.meta.url);
const { descriptor } = parse(readFileSync(file, "utf8"), { filename: file.pathname });
// Bind the compiled component to this test's Vue instance and resolve the @lib alias.
const code = compileScript(descriptor, { id: "record-detail-popup", inlineTemplate: true }).content
  .replace(/from ["']vue["']/g, `from ${JSON.stringify(import.meta.resolve("vue"))}`)
  .replace(/from ["']@lib\/([^"']+)["']/g, (_, path) =>
    `from ${JSON.stringify(new URL(`../../competition/modules/traffic/lib/${path}`, import.meta.url).href)}`);
const { default: RecordDetailPopup } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

function element(type) {
  const listeners = {};
  return {
    type, children: [], props: {}, value: "", listeners,
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    removeEventListener: (name, fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); },
    focus() { this.focused = true; },
    // v-model checks whether a detached element is the focused node of its document.
    getRootNode() { return this; },
  };
}

function mount(record, { busy = false, confirm = () => true } = {}) {
  const emitted = [];
  const prompts = [];
  const windowListeners = {};
  const renderer = Vue.createRenderer({
    createElement: element,
    createText: (text) => ({ text }),
    createComment: () => ({ comment: true }),
    setText(node, text) { node.text = text; },
    setElementText(node, text) { node.children = [{ text, parent: node }]; },
    insert(node, parent, anchor) {
      const at = anchor ? parent.children.indexOf(anchor) : -1;
      if (at === -1) parent.children.push(node);
      else parent.children.splice(at, 0, node);
      node.parent = parent;
    },
    remove(node) {
      const siblings = node.parent?.children;
      if (siblings) siblings.splice(siblings.indexOf(node), 1);
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node, key, old, value) { node.props[key] = value; },
  });
  const previous = { window: globalThis.window, Document: globalThis.Document, ShadowRoot: globalThis.ShadowRoot };
  globalThis.Document ??= class Document {};
  globalThis.ShadowRoot ??= class ShadowRoot {};
  globalThis.window = {
    confirm: (message) => { prompts.push(message); return confirm(); },
    addEventListener: (name, fn) => { windowListeners[name] = fn; },
    removeEventListener: (name) => { delete windowListeners[name]; },
  };
  const app = renderer.createApp({
    render: () => Vue.h(RecordDetailPopup, {
      record, busy,
      onSave: (detail) => emitted.push(["save", detail]),
      onClose: () => emitted.push(["close"]),
    }),
  });
  const root = { children: [] };
  app.mount(root);
  const all = (node) => [node, ...(node.children || []).flatMap(all)];
  const find = (predicate) => all(root).find(predicate);
  const byTestId = (id) => find((node) => node.props?.["data-testid"] === id);
  const text = (node) => node.text ?? (node.children || []).map(text).join("");
  return {
    emitted, prompts, root, find, byTestId, text,
    all: () => all(root),
    type(value) {
      const input = byTestId("record-detail-input");
      input.value = value;
      for (const fn of input.listeners.input || []) fn({ target: input });
    },
    submit: () => find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }),
    clickButton: (label) => find((node) => node.type === "button" && text(node) === label).props.onClick({}),
    clickOverlay() {
      const overlay = find((node) => node.props?.class === "record-popup-overlay");
      overlay.props.onClick({ target: overlay, currentTarget: overlay });
    },
    clickDialog() {
      const overlay = find((node) => node.props?.class === "record-popup-overlay");
      const dialog = find((node) => node.props?.role === "dialog");
      overlay.props.onClick({ target: dialog, currentTarget: overlay });
    },
    pressKey: (key) => windowListeners.keydown?.({ key }),
    unmount() {
      app.unmount();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    },
  };
}

const skidpad = { rowid: 7, num: 12, univ: "서울대학교", team: "FSA", type: "스키드패드", result: 5123, status: null, detail: "00:05.100 / 00:05.123" };

test("opens an editable record with its detail focused in the input", () => {
  const c = mount(skidpad);
  try {
    const input = c.byTestId("record-detail-input");
    assert.equal(input.value, skidpad.detail);
    assert.equal(input.focused, true);
    assert.equal(c.byTestId("record-detail-save").props.disabled, true);
  } finally { c.unmount(); }
});

test("saves an edited detail", async () => {
  const c = mount(skidpad);
  try {
    c.type("재측정");
    await Vue.nextTick();
    assert.equal(c.byTestId("record-detail-save").props.disabled, false);
    c.submit();
    assert.deepEqual(c.emitted, [["save", "재측정"]]);
  } finally { c.unmount(); }
});

test("does not save an unchanged detail or while saving", async () => {
  const unchanged = mount(skidpad);
  try {
    unchanged.submit();
    assert.deepEqual(unchanged.emitted, []);
  } finally { unchanged.unmount(); }

  const busy = mount(skidpad, { busy: true });
  try {
    busy.type("재측정");
    await Vue.nextTick();
    assert.equal(busy.byTestId("record-detail-input").props.disabled, true);
    busy.submit();
    assert.deepEqual(busy.emitted, []);
  } finally { busy.unmount(); }
});

test("an untouched draft follows another operator's saved detail", async () => {
  const record = Vue.reactive({ ...skidpad, detail: "A" });
  const c = mount(record);
  try {
    record.detail = "B";
    await Vue.nextTick();
    assert.equal(c.byTestId("record-detail-input").value, "B");
    assert.equal(c.byTestId("record-detail-save").props.disabled, true);
    c.submit();
    c.clickButton("취소");
    assert.deepEqual(c.emitted, [["close"]]);
    assert.deepEqual(c.prompts, []);
  } finally { c.unmount(); }
});

test("an edited draft survives another operator's save", async () => {
  const record = Vue.reactive({ ...skidpad, detail: "A" });
  const c = mount(record);
  try {
    c.type("X");
    await Vue.nextTick();
    record.detail = "B";
    await Vue.nextTick();
    assert.equal(c.byTestId("record-detail-input").value, "X");
    c.submit();
    assert.deepEqual(c.emitted, [["save", "X"]]);
  } finally { c.unmount(); }
});

test("another operator's update does not pull focus back to the input", async () => {
  const record = Vue.reactive({ ...skidpad });
  const c = mount(record);
  try {
    const input = c.byTestId("record-detail-input");
    assert.equal(input.focused, true);
    input.focused = false; // e.g. Tab to 취소
    record.status = "DSQ";
    await Vue.nextTick();
    assert.equal(input.focused, false);
  } finally { c.unmount(); }
});

test("closes a clean popup from the close button, overlay, and Escape", () => {
  for (const action of ["clickClose", "clickOverlay", "escape"]) {
    const c = mount(skidpad);
    try {
      if (action === "clickClose") c.clickButton("✕");
      else if (action === "clickOverlay") c.clickOverlay();
      else c.pressKey("Escape");
      assert.deepEqual(c.emitted, [["close"]], action);
      assert.deepEqual(c.prompts, [], action);
    } finally { c.unmount(); }
  }
});

test("clicking inside the dialog does not close it", () => {
  const c = mount(skidpad);
  try {
    c.clickDialog();
    assert.deepEqual(c.emitted, []);
  } finally { c.unmount(); }
});

test("closing with an unsaved edit asks before discarding it", async () => {
  const kept = mount(skidpad, { confirm: () => false });
  try {
    kept.type("메모");
    await Vue.nextTick();
    kept.clickButton("취소");
    assert.equal(kept.prompts.length, 1);
    assert.deepEqual(kept.emitted, []);
  } finally { kept.unmount(); }

  const discarded = mount(skidpad, { confirm: () => true });
  try {
    discarded.type("메모");
    await Vue.nextTick();
    discarded.pressKey("Escape");
    assert.deepEqual(discarded.emitted, [["close"]]);
  } finally { discarded.unmount(); }
});

test("endurance records show their laps read-only", () => {
  const c = mount({ ...skidpad, type: "내구", result: 185000, detail: "01:02.000 / 01:00.500 / 01:02.500" });
  try {
    assert.equal(c.byTestId("record-detail-input"), undefined);
    const classes = (node) => String(node.props?.class || "").split(" ");
    const rows = c.all().filter((node) => classes(node).includes("lap-row"));
    assert.equal(rows.length, 3);
    assert.equal(c.byTestId("record-detail-raw"), undefined);
    c.pressKey("Escape");
    assert.deepEqual(c.emitted, [["close"]]);
    assert.deepEqual(c.prompts, []);
  } finally { c.unmount(); }
});

test("endurance records without laps are not editable", () => {
  const c = mount({ ...skidpad, type: "내구", result: null, status: "DNF", detail: null });
  try {
    assert.equal(c.byTestId("record-detail-input"), undefined);
    assert.equal(c.byTestId("record-detail-raw"), undefined);
  } finally { c.unmount(); }
});

test("endurance details that are not a lap list are shown as written", () => {
  for (const detail of ["(수동)", "센서 오류로 수동 계측 (수동)"]) {
    const c = mount({ ...skidpad, type: "내구", result: 123500, detail });
    try {
      assert.equal(c.byTestId("record-detail-input"), undefined);
      const raw = c.byTestId("record-detail-raw");
      assert.ok(raw, "original detail is shown");
      assert.equal(c.text(raw), detail);
    } finally { c.unmount(); }
  }
});

test("endurance details with unreadable parts show the laps and the original text", () => {
  const detail = "01:02.000 / 01:00.500 (수동)";
  const c = mount({ ...skidpad, type: "내구", result: 122500, detail });
  try {
    const rows = c.all().filter((node) => String(node.props?.class || "").split(" ").includes("lap-row"));
    assert.equal(rows.length, 1);
    const raw = c.byTestId("record-detail-raw");
    assert.ok(raw, "original detail is shown");
    assert.equal(c.text(raw), detail);
  } finally { c.unmount(); }
});
