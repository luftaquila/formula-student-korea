import { ref } from "vue";
import { currentCompetitionYear } from "@shared/common/competition-year.mjs";
import { createServiceSSE, parseSSEData } from "@shared/browser/useSSE.js";

const year = currentCompetitionYear();
const {
  on,
  useSSE: useConnection,
  reconnected,
} = createServiceSSE(
  "/competition/api/v1/registration",
  `/api/events?year=${encodeURIComponent(year)}`,
);

const registrationRevision = ref(0);
const lastEntriesUpdate = ref(null);

on("registration", (event) => {
  const data = parseSSEData(event);
  if (!data || data.year !== year) return;
  registrationRevision.value += 1;
});

on("entries", (event) => {
  const data = parseSSEData(event);
  if (!data || data.year !== year) return;
  lastEntriesUpdate.value = { ...data, timestamp: Date.now() };
});

export function useRegistrationSSE(enabled = true) {
  useConnection(enabled);
  return { registrationRevision, lastEntriesUpdate, reconnected };
}
