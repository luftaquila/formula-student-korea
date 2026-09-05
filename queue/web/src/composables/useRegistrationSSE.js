import { ref } from "vue";
import { currentCompetitionYear } from "@shared/competition-year.mjs";
import { createServiceSSE, parseSSEData } from "@shared/useSSE.js";

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

on("registration", (event) => {
  const data = parseSSEData(event);
  if (!data || data.year !== year) return;
  registrationRevision.value += 1;
});

export function useRegistrationSSE() {
  useConnection();
  return { registrationRevision, reconnected };
}
