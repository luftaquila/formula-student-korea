import { ref } from "vue";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { createServiceSSE, parseSSEData } from "@shared/useSSE.js";

const year = currentCompetitionYear();
const {
  on,
  useSSE: useConnection,
  connected,
  reconnected,
} = createServiceSSE(
  "/competition/api/v1/registration",
  `/api/events?year=${encodeURIComponent(year)}`,
);

const status = ref(null);
const registrationRevision = ref(0);
const entriesRevision = ref(0);

function updateStatus(event) {
  const data = parseSSEData(event);
  if (!data || data.year !== year) return null;
  if (typeof data.open === "boolean" && Number.isInteger(data.waiting)) status.value = data;
  return data;
}

on("init", updateStatus);
on("registration", (event) => {
  if (!updateStatus(event)) return;
  registrationRevision.value += 1;
});
on("entries", (event) => {
  const data = parseSSEData(event);
  if (!data || data.year !== year) return;
  entriesRevision.value += 1;
});

export function useRegistrationSSE() {
  useConnection();
  return {
    status,
    registrationRevision,
    entriesRevision,
    connected,
    reconnected,
  };
}
