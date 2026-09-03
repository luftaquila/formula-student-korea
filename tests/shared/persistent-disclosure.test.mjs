import assert from "node:assert/strict";
import test from "node:test";

import {
  readDisclosureState,
  writeDisclosureState,
} from "../../shared/persistent-disclosure.js";

function memoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("disclosures default open and restore both persisted states", () => {
  const storage = memoryStorage([
    ["open-section", "open"],
    ["closed-section", "closed"],
  ]);

  assert.equal(readDisclosureState(storage, "missing"), true);
  assert.equal(readDisclosureState(storage, "open-section"), true);
  assert.equal(readDisclosureState(storage, "closed-section"), false);
});

test("disclosures persist explicit open and closed states", () => {
  const storage = memoryStorage();

  writeDisclosureState(storage, "resources", false);
  assert.equal(readDisclosureState(storage, "resources"), false);
  writeDisclosureState(storage, "resources", true);
  assert.equal(readDisclosureState(storage, "resources"), true);
});

test("disclosures fail safely when storage is unavailable or corrupted", () => {
  const brokenStorage = {
    getItem() {
      throw new Error("storage unavailable");
    },
    setItem() {
      throw new Error("storage unavailable");
    },
  };
  const corruptedStorage = memoryStorage([["resources", "unexpected"]]);

  assert.equal(readDisclosureState(brokenStorage, "resources"), true);
  assert.equal(readDisclosureState(corruptedStorage, "resources"), true);
  assert.doesNotThrow(() => writeDisclosureState(brokenStorage, "resources", false));
});
