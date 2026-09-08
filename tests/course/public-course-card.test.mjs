import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import * as Vue from "vue";

const { descriptor } = parse(readFileSync(new URL("../../course/web/src/views/PublicCourseView.vue", import.meta.url), "utf8"));
const render = Vue.compile(descriptor.template.content, { prefixIdentifiers: true });

function fixture() {
  const state = { courses: [{ id: 1, name: "First" }, { id: 2, name: "Second" }], details: { 1: {}, 2: {} }, selectedId: 1, overlays: {}, loading: false };
  const downloads = [];
  const renderer = Vue.createRenderer({
    createElement: (type) => ({ type, children: [], props: {} }),
    createText: (text) => ({ text }), createComment: () => ({}),
    insert(node, parent) { parent.children.push(node); node.parent = parent; },
    remove() {}, setText() {}, setElementText() {},
    parentNode: (node) => node.parent, nextSibling: () => null,
    patchProp(node, key, old, value) { node.props[key] = value; },
  });
  const app = renderer.createApp({
    render,
    setup: () => ({ state, active: null, geometries: {}, exportingId: null, toolMode: "none", data: {},
      download: (id) => downloads.push(id), toggleOverlay: (id) => { state.overlays[id] = true; },
    }),
  });
  app.component("CourseMapIcon", { render: () => null });
  const root = { children: [] };
  app.mount(root);
  const all = (node) => [node, ...(node.children || []).flatMap(all)];
  const card = all(root).filter((node) => node.type === "li")[1];
  function click(node) {
    let stopped = false;
    const event = { target: node, stopPropagation() { stopped = true; } };
    for (let current = node; current && !stopped; current = current.parent) current.props?.onClick?.(event);
  }
  return { state, downloads, card, all, click, app };
}

test("clicking the space between card actions selects the course", () => {
  const f = fixture();
  try {
    const download = f.all(f.card).find((node) => node.props?.["aria-label"] === "Asseto Corsa 트랙 다운로드");
    f.click(download.parent);
    assert.equal(f.state.selectedId, 2);
  } finally { f.app.unmount(); }
});

test("card action buttons do not select the course", () => {
  const f = fixture();
  try {
    f.click(f.all(f.card).find((node) => node.props?.["aria-label"] === "Asseto Corsa 트랙 다운로드"));
    f.click(f.all(f.card).find((node) => node.props?.["aria-label"] === "코스 표시"));
    assert.deepEqual(f.downloads, [2]);
    assert.equal(f.state.overlays[2], true);
    assert.equal(f.state.selectedId, 1);
  } finally { f.app.unmount(); }
});
