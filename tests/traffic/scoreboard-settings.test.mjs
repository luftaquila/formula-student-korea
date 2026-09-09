import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EVENT_LABEL_LENGTH,
  scoreboardEventLabels,
} from "../../competition/modules/traffic/web/src/utils/scoreboard-settings.js";

const EVENT_CONFIG = {
  가속: { label: "ACCELERATION" },
  스키드패드: { label: "SKIDPAD" },
  오토크로스: { label: "AUTOCROSS" },
};

test("scoreboard event labels use defaults without valid saved settings", () => {
  assert.deepEqual(scoreboardEventLabels(EVENT_CONFIG, null), {
    가속: "ACCELERATION",
    스키드패드: "SKIDPAD",
    오토크로스: "AUTOCROSS",
  });
  assert.deepEqual(scoreboardEventLabels(EVENT_CONFIG, "not-json"), {
    가속: "ACCELERATION",
    스키드패드: "SKIDPAD",
    오토크로스: "AUTOCROSS",
  });
});

test("scoreboard event labels preserve custom line breaks", () => {
  const labels = scoreboardEventLabels(EVENT_CONFIG, JSON.stringify({
    스키드패드: "스키드\r\n패드",
    오토크로스: "오토\n크로스",
  }));

  assert.equal(labels.가속, "ACCELERATION");
  assert.equal(labels.스키드패드, "스키드\n패드");
  assert.equal(labels.오토크로스, "오토\n크로스");
});

test("scoreboard event labels accept blank labels and bound stored values", () => {
  const labels = scoreboardEventLabels(EVENT_CONFIG, JSON.stringify({
    가속: "",
    스키드패드: "가".repeat(MAX_EVENT_LABEL_LENGTH + 10),
    unknown: "ignored",
  }));

  assert.equal(labels.가속, "");
  assert.equal(labels.스키드패드, "가".repeat(MAX_EVENT_LABEL_LENGTH));
  assert.equal(Object.hasOwn(labels, "unknown"), false);
});
