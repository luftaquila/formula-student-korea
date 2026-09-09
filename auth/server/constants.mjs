// One-time compatibility map for databases written by the unmerged bundle-based
// preview. Bundles are flattened into explicit grants and the legacy table is
// removed during startup; runtime authorization never reads this map.
export const LEGACY_PERMISSION_BUNDLES = Object.freeze({
  registration_operator: ["registration.operate"],
  registration_manager: ["registration.manage"],
  queue_operator: ["queue.operate"],
  queue_manager: ["queue.manage"],
  inspection_operator: ["inspection.operate"],
  inspection_manager: ["inspection.manage"],
  documents_reviewer: ["documents.operate"],
  documents_manager: ["documents.manage", "files.access"],
  calendar_manager: ["calendar.manage"],
  course_editor: ["course.operate"],
  course_manager: ["course.manage"],
  rover_operator: ["rover.operate"],
  timing_operator: ["traffic.operate"],
  timing_manager: ["traffic.manage"],
  score_operator: ["score.operate"],
  score_manager: ["score.manage"],
  entry_manager: [],
  application_manager: [],
  contacts_manager: [],
  messaging_operator: [],
  auditor: [],
});
