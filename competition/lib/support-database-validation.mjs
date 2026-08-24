const column = (name, type, notnull = 0, pk = 0, defaultValue = null) =>
  Object.freeze({ name, type, notnull, pk, defaultValue });

const LOG_COLUMNS = Object.freeze([
  column("id", "INTEGER", 0, 1),
  column("timestamp", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
  column("level", "TEXT", 1, 0, "'info'"),
  column("action", "TEXT", 1),
  column("actor_email", "TEXT"),
  column("actor_name", "TEXT"),
  column("actor_role", "TEXT"),
  column("target", "TEXT"),
  column("detail", "TEXT"),
  column("ip", "TEXT"),
  column("module", "TEXT"),
]);

const MIGRATION_COLUMNS = Object.freeze([
  column("name", "TEXT", 0, 1),
  column("applied_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
]);

const LOG_INDEXES = Object.freeze([
  ["idx_logs_timestamp", "logs", 0, ["timestamp"]],
  ["idx_logs_action", "logs", 0, ["action"]],
  ["idx_logs_module_timestamp", "logs", 0, ["module", "timestamp"]],
  ["idx_logs_module_id", "logs", 0, ["module", "id"]],
]);

const LOG_TRIGGER = Object.freeze({
  name: "trg_logs_retention",
  table: "logs",
  fragments: [
    "afterinsertonlogs", "deletefromlogs", "moduleisnew.module",
    "orderbyiddesc", "limit-1offset",
  ],
});

const fk = (table, from, to, onDelete) =>
  Object.freeze({ table, from, to, onDelete, onUpdate: "NO ACTION" });

export const SUPPORT_DATABASE_CONTRACTS = Object.freeze({
  auth: Object.freeze({
    tables: Object.freeze({
      users: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("email", "TEXT", 1),
        column("name", "TEXT"),
        column("role", "TEXT", 1),
        column("memo", "TEXT", 0, 0, "''"),
        column("realname", "TEXT", 0, 0, "''"),
        column("phone", "TEXT", 0, 0, "''"),
        column("created_at", "TEXT"),
        column("active", "INTEGER", 0, 0, "1"),
        column("affiliation", "TEXT", 0, 0, "''"),
      ]),
      settings: Object.freeze([
        column("key", "TEXT", 0, 1),
        column("value", "TEXT", 1),
      ]),
      applications: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("email", "TEXT", 1),
        column("name", "TEXT"),
        column("realname", "TEXT", 1, 0, "''"),
        column("phone", "TEXT", 1, 0, "''"),
        column("affiliation", "TEXT", 1, 0, "''"),
        column("created_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
        column("updated_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
      ]),
      ops_display: Object.freeze([
        column("user_id", "INTEGER", 0, 1),
        column("description", "TEXT", 1, 0, "''"),
        column("sort_order", "INTEGER", 1, 0, "0"),
      ]),
      logs: LOG_COLUMNS,
      schema_migrations: MIGRATION_COLUMNS,
    }),
    indexes: Object.freeze([...LOG_INDEXES]),
    uniqueIndexes: Object.freeze([
      ["users", ["email"]],
      ["applications", ["email"]],
    ]),
    foreignKeys: Object.freeze({
      ops_display: Object.freeze([fk("users", "user_id", "id", "NO ACTION")]),
    }),
    tableSqlFragments: Object.freeze({
      users: Object.freeze(["unique", "check(rolein('admin','chief','official','student'))"]),
      applications: Object.freeze(["emailtextuniquenotnull"]),
    }),
    triggers: Object.freeze([LOG_TRIGGER]),
  }),

  calendar: Object.freeze({
    tables: Object.freeze({
      events: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("title", "TEXT", 1),
        column("description", "TEXT", 1, 0, "''"),
        column("location", "TEXT", 1, 0, "''"),
        column("start", "TEXT", 1),
        column("end", "TEXT", 1),
        column("all_day", "INTEGER", 1, 0, "0"),
        column("role", "TEXT", 1, 0, "'official'"),
      ]),
      logs: LOG_COLUMNS,
      schema_migrations: MIGRATION_COLUMNS,
    }),
    indexes: Object.freeze([
      ...LOG_INDEXES,
      ["idx_events_role_start", "events", 0, ["role", "start"]],
      ["idx_events_all_day_end_start", "events", 0, ["all_day", "end", "start"]],
    ]),
    uniqueIndexes: Object.freeze([]),
    foreignKeys: Object.freeze({}),
    tableSqlFragments: Object.freeze({}),
    triggers: Object.freeze([LOG_TRIGGER]),
  }),

  course: Object.freeze({
    tables: Object.freeze({
      course: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("name", "TEXT", 1),
        column("created_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
        column("updated_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
        column("reverse", "INTEGER", 1, 0, "0"),
        column("start_cone_id", "INTEGER"),
      ]),
      cone: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("course_id", "INTEGER", 1),
        column("lat", "REAL", 1),
        column("lng", "REAL", 1),
        column("alt", "REAL"),
        column("side", "TEXT", 1),
        column("created_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
        column("updated_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
      ]),
      memo: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("course_id", "INTEGER", 1),
        column("lat", "REAL", 1),
        column("lng", "REAL", 1),
        column("width", "REAL", 1),
        column("height", "REAL", 1),
        column("rotation", "REAL", 1, 0, "0"),
        column("content", "TEXT", 1, 0, "''"),
        column("created_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
        column("updated_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
      ]),
      course_snapshot: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("course_id", "INTEGER", 1),
        column("taken_at", "INTEGER", 1),
        column("actor", "TEXT"),
        column("reason", "TEXT"),
        column("cones_json", "TEXT", 1),
      ]),
      mission: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("course_id", "INTEGER"),
        column("started_at", "INTEGER", 1),
        column("ended_at", "INTEGER"),
        column("status", "TEXT", 1, 0, "'running'"),
        column("waypoints_json", "TEXT", 1),
        column("current_waypoint_idx", "INTEGER", 1, 0, "0"),
        column("spray_results_json", "TEXT", 1, 0, "'{}'"),
        column("updated_at", "INTEGER"),
        column("actor", "TEXT"),
        column("created_at", "INTEGER"),
        column("activated_at", "INTEGER"),
        column("preset_id", "INTEGER"),
        column("lifecycle_state", "TEXT"),
        column("hold_reason", "TEXT"),
        column("finish_behavior", "TEXT", 1, 0, "'stop'"),
        column("plan_hash", "TEXT"),
        column("start_lat", "REAL"),
        column("start_lng", "REAL"),
        column("start_alt", "REAL"),
        column("last_rover_boot_id", "TEXT"),
        column("active_command_id", "TEXT"),
        column("protocol_version", "INTEGER", 1, 0, "1"),
      ]),
      mission_route_preset: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("course_id", "INTEGER", 1),
        column("name", "TEXT", 1),
        column("finish_behavior", "TEXT", 1, 0, "'stop'"),
        column("created_at", "INTEGER", 1),
        column("updated_at", "INTEGER", 1),
        column("actor", "TEXT"),
      ]),
      mission_route_preset_item: Object.freeze([
        column("id", "TEXT", 0, 1),
        column("preset_id", "INTEGER", 1),
        column("position", "INTEGER", 1),
        column("cone_id", "INTEGER"),
        column("cone_id_snapshot", "INTEGER", 1),
        column("lat_snapshot", "REAL", 1),
        column("lng_snapshot", "REAL", 1),
        column("alt_snapshot", "REAL"),
        column("side_snapshot", "TEXT"),
      ]),
      mission_waypoint: Object.freeze([
        column("id", "TEXT", 0, 1),
        column("mission_id", "INTEGER", 1),
        column("position", "INTEGER"),
        column("cone_id", "INTEGER"),
        column("cone_id_snapshot", "INTEGER"),
        column("lat", "REAL", 1),
        column("lng", "REAL", 1),
        column("alt", "REAL"),
        column("side", "TEXT"),
        column("state", "TEXT", 1, 0, "'pending'"),
        column("outcome", "TEXT"),
        column("attempt_count", "INTEGER", 1, 0, "0"),
        column("completed_at", "INTEGER"),
        column("skipped_at", "INTEGER"),
        column("skip_reason", "TEXT"),
        column("created_at", "INTEGER", 1),
        column("updated_at", "INTEGER", 1),
      ]),
      mission_command: Object.freeze([
        column("id", "TEXT", 0, 1),
        column("mission_id", "INTEGER", 1),
        column("command_seq", "INTEGER", 1),
        column("action", "TEXT", 1),
        column("plan_hash", "TEXT"),
        column("state", "TEXT", 1, 0, "'pending'"),
        column("requested_at", "INTEGER", 1),
        column("acknowledged_at", "INTEGER"),
        column("actor", "TEXT"),
        column("rover_boot_id", "TEXT"),
        column("reject_reason", "TEXT"),
        column("payload_json", "TEXT", 1),
      ]),
      mission_event: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("mission_id", "INTEGER", 1),
        column("event_type", "TEXT", 1),
        column("t", "INTEGER", 1),
        column("waypoint_id", "TEXT"),
        column("command_id", "TEXT"),
        column("rover_boot_id", "TEXT"),
        column("actor", "TEXT"),
        column("before_json", "TEXT"),
        column("after_json", "TEXT"),
        column("detail_json", "TEXT"),
      ]),
      mission_telemetry: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("mission_id", "INTEGER", 1),
        column("t", "INTEGER", 1),
        column("lat", "REAL"),
        column("lng", "REAL"),
        column("fix_status", "TEXT"),
        column("nav_state", "TEXT"),
        column("ntrip_connected", "INTEGER"),
        column("corr_age_ms", "INTEGER"),
        column("ntrip_fail_count", "INTEGER"),
        column("h_acc_m", "REAL"),
        column("altitude_m", "REAL"),
        column("v_acc_m", "REAL"),
      ]),
      gps_config: Object.freeze([
        column("key", "TEXT", 0, 1),
        column("value", "TEXT"),
      ]),
      survey_point: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("name", "TEXT", 1),
        column("lat", "REAL"),
        column("lng", "REAL"),
        column("alt", "REAL"),
        column("h_acc_m", "REAL"),
        column("samples", "INTEGER"),
        column("surveyed_at", "TEXT"),
        column("created_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
        column("updated_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
      ]),
      logs: LOG_COLUMNS,
      schema_migrations: MIGRATION_COLUMNS,
    }),
    indexes: Object.freeze([
      ...LOG_INDEXES,
      ["idx_cone_course", "cone", 0, ["course_id"]],
      ["idx_memo_course", "memo", 0, ["course_id"]],
      ["idx_course_snapshot", "course_snapshot", 0, ["course_id", "taken_at"]],
      ["idx_mission_started", "mission", 0, ["started_at"]],
      ["idx_mission_telemetry", "mission_telemetry", 0, ["mission_id", "t"]],
      ["idx_mission_one_active", "mission", 1, [null]],
      ["idx_mission_preset_course", "mission_route_preset", 0, ["course_id", "updated_at"]],
      ["idx_mission_waypoint_state", "mission_waypoint", 0, ["mission_id", "state", "position"]],
      ["idx_mission_command_pending", "mission_command", 0, ["state", "requested_at"]],
      ["idx_mission_event_mission", "mission_event", 0, ["mission_id", "t", "id"]],
    ]),
    uniqueIndexes: Object.freeze([
      ["course", ["name"]],
      ["survey_point", ["name"]],
      ["mission_route_preset", ["course_id", "name"]],
      ["mission_route_preset_item", ["preset_id", "position"]],
      ["mission_waypoint", ["mission_id", "position"]],
      ["mission_command", ["mission_id", "command_seq"]],
    ]),
    foreignKeys: Object.freeze({
      cone: Object.freeze([fk("course", "course_id", "id", "CASCADE")]),
      memo: Object.freeze([fk("course", "course_id", "id", "CASCADE")]),
      course_snapshot: Object.freeze([fk("course", "course_id", "id", "CASCADE")]),
      mission: Object.freeze([fk("course", "course_id", "id", "SET NULL")]),
      mission_telemetry: Object.freeze([fk("mission", "mission_id", "id", "CASCADE")]),
      mission_route_preset: Object.freeze([fk("course", "course_id", "id", "CASCADE")]),
      mission_route_preset_item: Object.freeze([
        fk("cone", "cone_id", "id", "SET NULL"),
        fk("mission_route_preset", "preset_id", "id", "CASCADE"),
      ]),
      mission_waypoint: Object.freeze([
        fk("cone", "cone_id", "id", "SET NULL"),
        fk("mission", "mission_id", "id", "CASCADE"),
      ]),
      mission_command: Object.freeze([fk("mission", "mission_id", "id", "CASCADE")]),
      mission_event: Object.freeze([fk("mission", "mission_id", "id", "CASCADE")]),
    }),
    tableSqlFragments: Object.freeze({
      course: Object.freeze(["nametextnotnullunique"]),
      cone: Object.freeze(["check(sidein('left','right','center'))"]),
      mission: Object.freeze([
        "check(statusin('running','paused','interrupted','completed','stopped','error'))",
      ]),
      mission_route_preset: Object.freeze([
        "check(finish_behaviorin('stop','return_to_start'))",
      ]),
      mission_waypoint: Object.freeze([
        "check(statein('pending','active','completed','skipped'))",
      ]),
      mission_command: Object.freeze([
        "check(actionin('start','pause','resume','end'))",
        "check(statein('pending','accepted','rejected','superseded'))",
      ]),
      survey_point: Object.freeze(["nametextnotnullunique"]),
    }),
    triggers: Object.freeze([
      LOG_TRIGGER,
      Object.freeze({
        name: "trg_mission_telemetry_retention",
        table: "mission_telemetry",
        fragments: Object.freeze([
          "afterinsertonmission_telemetry", "deletefrommission_telemetry",
          "selectmax(id)frommission_telemetry", "-",
        ]),
      }),
    ]),
  }),

  email: Object.freeze({
    tables: Object.freeze({
      config: Object.freeze([
        column("key", "TEXT", 0, 1),
        column("value", "TEXT", 1, 0, "''"),
      ]),
      email_log: Object.freeze([
        column("id", "INTEGER", 0, 1),
        column("subject", "TEXT", 1),
        column("recipient", "TEXT", 1, 0, "''"),
        column("status", "TEXT", 1, 0, "'sent'"),
        column("error", "TEXT"),
        column("message_id", "TEXT"),
        column("html_content", "TEXT"),
        column("source", "TEXT", 1, 0, "'manual'"),
        column("sent_at", "TEXT", 1, 0, "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
        column("sent_by", "TEXT"),
      ]),
      logs: LOG_COLUMNS,
      schema_migrations: MIGRATION_COLUMNS,
    }),
    indexes: Object.freeze([
      ...LOG_INDEXES,
      ["idx_el_sent_at", "email_log", 0, ["sent_at"]],
      ["idx_el_status_sent_at", "email_log", 0, ["status", "sent_at"]],
    ]),
    uniqueIndexes: Object.freeze([]),
    foreignKeys: Object.freeze({}),
    tableSqlFragments: Object.freeze({}),
    triggers: Object.freeze([
      LOG_TRIGGER,
      Object.freeze({
        name: "trg_email_log_retention",
        table: "email_log",
        fragments: Object.freeze([
          "afterinsertonemail_log", "deletefromemail_log",
          "selectmax(id)fromemail_log", "-",
        ]),
      }),
    ]),
  }),
});

function normalizeDefault(value) {
  if (value == null) return null;
  let normalized = String(value).toLowerCase().replace(/\s+/g, "");
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function normalizeSql(value) {
  return String(value || "").toLowerCase().replace(/[\s"`\[\]]+/g, "");
}

function actualColumns(db, table) {
  return db.pragma(`table_info(${JSON.stringify(table)})`).map((entry) => ({
    name: entry.name,
    type: String(entry.type || "").toUpperCase(),
    notnull: Number(entry.notnull),
    pk: Number(entry.pk),
    defaultValue: normalizeDefault(entry.dflt_value),
  }));
}

function expectedColumns(columns) {
  return columns.map((entry) => ({
    ...entry,
    defaultValue: normalizeDefault(entry.defaultValue),
  }));
}

function indexColumns(db, index) {
  return db.pragma(`index_info(${JSON.stringify(index)})`).map(({ name }) => name);
}

function hasUniqueIndex(db, table, expected) {
  return db.pragma(`index_list(${JSON.stringify(table)})`).some((index) =>
    Number(index.unique) === 1
      && JSON.stringify(indexColumns(db, index.name)) === JSON.stringify(expected));
}

function actualForeignKeys(db, table) {
  return db.pragma(`foreign_key_list(${JSON.stringify(table)})`).map((entry) => ({
    table: entry.table,
    from: entry.from,
    to: entry.to,
    onDelete: entry.on_delete,
    onUpdate: entry.on_update,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function fail(service, incompatible) {
  throw new Error(`missing or incompatible ${service} runtime schema: ${incompatible.join(", ")}`);
}

export function assertSupportDatabaseSchema(db, service) {
  const contract = SUPPORT_DATABASE_CONTRACTS[service];
  if (!contract) throw new Error(`unknown support database service: ${service}`);
  const incompatible = [];

  for (const [table, columns] of Object.entries(contract.tables)) {
    const object = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?").get(table);
    if (object?.type !== "table") {
      incompatible.push(`${table}<table:missing>`);
      continue;
    }
    if (JSON.stringify(actualColumns(db, table)) !== JSON.stringify(expectedColumns(columns))) {
      incompatible.push(`${table}<table:columns>`);
    }
    const expectedFks = [...(contract.foreignKeys[table] || [])]
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    if (JSON.stringify(actualForeignKeys(db, table)) !== JSON.stringify(expectedFks)) {
      incompatible.push(`${table}<table:foreign-keys>`);
    }
    const normalizedSql = normalizeSql(object.sql);
    for (const fragment of contract.tableSqlFragments[table] || []) {
      if (!normalizedSql.includes(fragment)) incompatible.push(`${table}<table:constraint>`);
    }
  }

  for (const [name, table, unique, columns] of contract.indexes) {
    const index = db.prepare("SELECT type, tbl_name FROM sqlite_master WHERE name = ?").get(name);
    const indexList = index?.type === "index"
      ? db.pragma(`index_list(${JSON.stringify(table)})`).find((entry) => entry.name === name)
      : null;
    if (index?.tbl_name !== table || Number(indexList?.unique) !== unique
      || JSON.stringify(indexColumns(db, name)) !== JSON.stringify(columns)) {
      incompatible.push(`${name}<index:definition>`);
    }
  }
  for (const [table, columns] of contract.uniqueIndexes) {
    if (!hasUniqueIndex(db, table, columns)) incompatible.push(`${table}<unique:${columns.join("+")}>`);
  }

  const allowedTriggers = new Set(contract.triggers.map(({ name }) => name));
  for (const trigger of contract.triggers) {
    const object = db.prepare(
      "SELECT type, tbl_name, sql FROM sqlite_master WHERE name = ?",
    ).get(trigger.name);
    const normalizedSql = normalizeSql(object?.sql);
    if (object?.type !== "trigger" || object.tbl_name !== trigger.table
      || trigger.fragments.some((fragment) => !normalizedSql.includes(fragment))) {
      incompatible.push(`${trigger.name}<trigger:definition>`);
    }
  }
  for (const { name } of db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'",
  ).all()) {
    if (!allowedTriggers.has(name)) incompatible.push(`${name}<trigger:unexpected>`);
  }

  if (incompatible.length) fail(service, incompatible);
  return true;
}

export function validateSupportDatabase(db, service) {
  db.pragma("query_only = ON");
  assertSupportDatabaseSchema(db, service);
  const integrity = db.pragma("integrity_check");
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity.slice(0, 20))}`);
  }
  const foreignKeyErrors = db.pragma("foreign_key_check");
  if (foreignKeyErrors.length) {
    throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(foreignKeyErrors.slice(0, 20))}`);
  }
  return true;
}
