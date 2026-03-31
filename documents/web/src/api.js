import { createApiClient } from "@shared/api-base.js";

export const { request, fetchEntryYears, fetchEntries, fetchVehicleTypes } = createApiClient("/documents");
