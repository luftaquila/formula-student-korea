const MAX_EVENT_LABEL_LENGTH = 40;

function normalizeEventLabel(value) {
  return value.replace(/\r\n?/g, "\n").slice(0, MAX_EVENT_LABEL_LENGTH);
}

export function scoreboardEventLabels(eventConfig, savedValue) {
  const labels = Object.fromEntries(
    Object.entries(eventConfig).map(([type, config]) => [type, config.label]),
  );

  try {
    const saved = JSON.parse(savedValue);
    for (const type of Object.keys(eventConfig)) {
      if (typeof saved?.[type] === "string") {
        labels[type] = normalizeEventLabel(saved[type]);
      }
    }
  } catch {
    // Ignore malformed local settings and keep the built-in labels.
  }

  return labels;
}

export { MAX_EVENT_LABEL_LENGTH };
