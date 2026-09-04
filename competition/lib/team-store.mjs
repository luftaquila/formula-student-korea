import { VEHICLE_COLORS } from "../../shared/constants.js";
import { assertCompetitionTeamWriteYear, parseCompetitionYear } from "../../shared/competition-year.mjs";
import {
  clearCanonicalTeamTransientState,
  updateCanonicalTeamProjections,
} from "./team-references.mjs";

const VEHICLE_COLOR_SET = new Set(VEHICLE_COLORS);

function httpError(message, status = 400, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function requireYear(value) {
  return parseCompetitionYear(value, { defaultCurrent: false });
}

function requireNum(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number >= 1_000_000_000) {
    throw httpError("올바르지 않은 엔트리 번호입니다.");
  }
  return number;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw httpError(`올바르지 않은 ${label}입니다.`);
  return value.trim();
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw httpError(`${label}는 불리언이어야 합니다.`);
  return value;
}

function requireId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw httpError(`올바르지 않은 ${label}입니다.`);
  return id;
}

function requireColor(value) {
  const color = value == null || value === "" ? "blue" : String(value).trim();
  if (!VEHICLE_COLOR_SET.has(color)) throw httpError("올바르지 않은 색상입니다.");
  return color;
}

function requireSortOrder(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const sortOrder = Number(value);
  if (!Number.isInteger(sortOrder)) throw httpError("올바르지 않은 정렬 순서입니다.");
  return sortOrder;
}

function rowToTeam(row) {
  return row ? {
    id: row.id,
    year: row.year,
    number: row.num,
    university: row.univ,
    name: row.name,
    vehicleTypeId: row.vehicle_type_id,
    vehicleType: row.vehicle_type_name,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function rowToVehicleType(row) {
  return row ? {
    id: row.id,
    year: row.year,
    name: row.display_name,
    color: row.color,
    sortOrder: row.sort_order,
  } : null;
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

export function ensureCompetitionTeamSchema(db) {
  // The pre-release snapshot/finalize schema is deliberately unsupported.
  // Production upgrades are performed by the one-shot migration into a new DB.
  if (tableExists(db, "competition_year_version")) {
    throw new Error("unsupported preview Competition schema: migrate into a clean database");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS competition_vehicle_type (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2099),
      display_name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'blue',
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(year, display_name)
    );

    CREATE TABLE IF NOT EXISTS competition_team (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2099),
      num INTEGER NOT NULL CHECK(num > 0 AND num < 1000000000),
      univ TEXT NOT NULL,
      name TEXT NOT NULL,
      vehicle_type_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(year, num),
      FOREIGN KEY (vehicle_type_id) REFERENCES competition_vehicle_type(id)
    );
    CREATE INDEX IF NOT EXISTS competition_team_year_active
      ON competition_team(year, active, num);
  `);
}

export class TeamStore {
  constructor(db) {
    this.db = db;
    ensureCompetitionTeamSchema(db);
  }

  listYears() {
    const years = new Set();
    const tables = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all();
    for (const { name } of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      if (!this.db.prepare(`PRAGMA table_info(${quoted})`).all().some((column) => column.name === "year")) continue;
      for (const { year } of this.db.prepare(`SELECT DISTINCT year FROM ${quoted}`).all()) {
        const numeric = Number(year);
        if (Number.isInteger(numeric) && numeric >= 2000 && numeric <= 2099) years.add(numeric);
      }
    }
    return [...years].sort((a, b) => b - a);
  }

  listVehicleTypes(yearValue) {
    const year = requireYear(yearValue);
    return this.db.prepare(`
      SELECT id, year, display_name, color, sort_order
      FROM competition_vehicle_type WHERE year = ? ORDER BY sort_order, id
    `).all(year).map(rowToVehicleType);
  }

  getVehicleType(idValue) {
    const id = requireId(idValue, "차량 유형 ID");
    return rowToVehicleType(this.db.prepare(`
      SELECT id, year, display_name, color, sort_order FROM competition_vehicle_type WHERE id = ?
    `).get(id));
  }

  listTeams(yearValue, { includeInactive = false } = {}) {
    const year = requireYear(yearValue);
    return this.db.prepare(`
      SELECT t.*, vt.display_name AS vehicle_type_name
      FROM competition_team t
      LEFT JOIN competition_vehicle_type vt ON vt.id = t.vehicle_type_id
      WHERE t.year = ? ${includeInactive ? "" : "AND t.active = 1"}
      ORDER BY t.num
    `).all(year).map(rowToTeam);
  }

  getById(idValue) {
    const id = requireId(idValue, "팀 ID");
    return rowToTeam(this.db.prepare(`
      SELECT t.*, vt.display_name AS vehicle_type_name
      FROM competition_team t
      LEFT JOIN competition_vehicle_type vt ON vt.id = t.vehicle_type_id
      WHERE t.id = ?
    `).get(id));
  }

  getByNumber(yearValue, numberValue, { includeInactive = true } = {}) {
    const year = requireYear(yearValue);
    const number = requireNum(numberValue);
    return rowToTeam(this.db.prepare(`
      SELECT t.*, vt.display_name AS vehicle_type_name
      FROM competition_team t
      LEFT JOIN competition_vehicle_type vt ON vt.id = t.vehicle_type_id
      WHERE t.year = ? AND t.num = ? ${includeInactive ? "" : "AND t.active = 1"}
    `).get(year, number));
  }

  #vehicleTypeId(year, value) {
    if (value == null || value === "") return null;
    const id = requireId(value, "차량 유형 ID");
    const type = this.getVehicleType(id);
    if (!type || type.year !== year) throw httpError("해당 연도에 존재하지 않는 차량 유형입니다.");
    return id;
  }

  #importVehicleTypeId(year, input) {
    if (input?.vehicleTypeId != null && input.vehicleTypeId !== "") {
      return this.#vehicleTypeId(year, input.vehicleTypeId);
    }
    if (input?.vehicleType == null || input.vehicleType === "") return null;
    const name = requireText(input.vehicleType, "차량 유형명");
    const type = this.db.prepare(`
      SELECT id FROM competition_vehicle_type WHERE year = ? AND display_name = ?
    `).get(year, name);
    if (!type) throw httpError(`해당 연도에 차량 유형 '${name}'이 존재하지 않습니다.`);
    return type.id;
  }

  createTeam(yearValue, input) {
    const year = assertCompetitionTeamWriteYear(yearValue);
    const number = requireNum(input?.number);
    const university = requireText(input?.university, "학교명");
    const name = requireText(input?.name, "팀명");
    const vehicleTypeId = this.#vehicleTypeId(year, input?.vehicleTypeId);
    const active = input?.active == null ? true : requireBoolean(input.active, "active");
    try {
      const result = this.db.prepare(`
        INSERT INTO competition_team (year, num, univ, name, vehicle_type_id, active)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(year, number, university, name, vehicleTypeId, active ? 1 : 0);
      return this.getById(result.lastInsertRowid);
    } catch (error) {
      if (error?.code?.startsWith?.("SQLITE_CONSTRAINT")) {
        throw httpError(`${year}년 ${number}번 팀이 이미 존재합니다.`, 409, "TEAM_NUMBER_CONFLICT");
      }
      throw error;
    }
  }

  updateTeam(idValue, patch) {
    const id = requireId(idValue, "팀 ID");
    return this.db.transaction(() => {
      const before = this.getById(id);
      if (!before) throw httpError("존재하지 않는 팀입니다.", 404, "TEAM_NOT_FOUND");
      assertCompetitionTeamWriteYear(before.year);
      const afterInput = {
        number: Object.hasOwn(patch || {}, "number") ? requireNum(patch.number) : before.number,
        university: Object.hasOwn(patch || {}, "university")
          ? requireText(patch.university, "학교명") : before.university,
        name: Object.hasOwn(patch || {}, "name") ? requireText(patch.name, "팀명") : before.name,
        vehicleTypeId: Object.hasOwn(patch || {}, "vehicleTypeId")
          ? this.#vehicleTypeId(before.year, patch.vehicleTypeId) : before.vehicleTypeId,
        active: Object.hasOwn(patch || {}, "active")
          ? requireBoolean(patch.active, "active") : before.active,
      };
      try {
        this.db.prepare(`
          UPDATE competition_team
          SET num = ?, univ = ?, name = ?, vehicle_type_id = ?, active = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?
        `).run(
          afterInput.number, afterInput.university, afterInput.name,
          afterInput.vehicleTypeId, afterInput.active ? 1 : 0, id,
        );
      } catch (error) {
        if (error?.code?.startsWith?.("SQLITE_CONSTRAINT")) {
          throw httpError(`${before.year}년 ${afterInput.number}번 팀이 이미 존재합니다.`, 409, "TEAM_NUMBER_CONFLICT");
        }
        throw error;
      }
      const after = this.getById(id);
      const projections = updateCanonicalTeamProjections(this.db, before, after);
      const clearedTransientState = before.active && !after.active
        ? clearCanonicalTeamTransientState(this.db, after)
        : {};
      return { before, after, projections, clearedTransientState };
    })();
  }

  importInitial(yearValue, raw) {
    const year = assertCompetitionTeamWriteYear(yearValue);
    if (this.db.prepare("SELECT 1 FROM competition_team WHERE year = ? LIMIT 1").get(year)) {
      throw httpError("이미 팀이 등록된 연도에는 일괄 가져오기를 할 수 없습니다.", 409, "TEAM_IMPORT_NOT_EMPTY");
    }
    let payload;
    try { payload = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { throw httpError("JSON 파일을 읽을 수 없습니다."); }
    if (!payload || !Array.isArray(payload.teams)) {
      throw httpError("teams 배열이 포함된 올바른 팀 가져오기 파일이 아닙니다.");
    }
    const seen = new Set();
    const teams = payload.teams.map((input) => {
      const number = requireNum(input?.number);
      if (seen.has(number)) throw httpError(`${number}번 팀이 중복되었습니다.`, 409, "TEAM_NUMBER_CONFLICT");
      seen.add(number);
      return {
        number,
        university: requireText(input?.university, "학교명"),
        name: requireText(input?.name, "팀명"),
        vehicleTypeId: this.#importVehicleTypeId(year, input),
        active: input?.active == null ? true : requireBoolean(input.active, "active"),
      };
    });
    this.db.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO competition_team (year, num, univ, name, vehicle_type_id, active)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const team of teams) {
        insert.run(year, team.number, team.university, team.name, team.vehicleTypeId, team.active ? 1 : 0);
      }
    })();
    return this.listTeams(year, { includeInactive: true });
  }

  exportTeams(yearValue) {
    const year = requireYear(yearValue);
    return { year, teams: this.listTeams(year, { includeInactive: true }).map((team) => ({
      number: team.number,
      university: team.university,
      name: team.name,
      vehicleType: team.vehicleType,
      active: team.active,
    })) };
  }

  createVehicleType(yearValue, input) {
    const year = assertCompetitionTeamWriteYear(yearValue);
    const name = requireText(input?.name, "차량 유형명");
    const color = requireColor(input?.color);
    const sortOrder = requireSortOrder(input?.sortOrder, this.listVehicleTypes(year).length);
    try {
      const result = this.db.prepare(`
        INSERT INTO competition_vehicle_type (year, display_name, color, sort_order) VALUES (?, ?, ?, ?)
      `).run(year, name, color, sortOrder);
      return this.getVehicleType(result.lastInsertRowid);
    } catch (error) {
      if (error?.code?.startsWith?.("SQLITE_CONSTRAINT")) {
        throw httpError(`차량 유형 '${name}'이 이미 존재합니다.`, 409, "VEHICLE_TYPE_CONFLICT");
      }
      throw error;
    }
  }

  updateVehicleType(idValue, patch) {
    const id = requireId(idValue, "차량 유형 ID");
    return this.db.transaction(() => {
      const before = this.getVehicleType(id);
      if (!before) throw httpError("존재하지 않는 차량 유형입니다.", 404, "VEHICLE_TYPE_NOT_FOUND");
      assertCompetitionTeamWriteYear(before.year);
      const name = Object.hasOwn(patch || {}, "name") ? requireText(patch.name, "차량 유형명") : before.name;
      const color = Object.hasOwn(patch || {}, "color") ? requireColor(patch.color) : before.color;
      const sortOrder = Object.hasOwn(patch || {}, "sortOrder")
        ? requireSortOrder(patch.sortOrder) : before.sortOrder;
      const affectedTeams = this.listTeams(before.year, { includeInactive: true })
        .filter((team) => team.vehicleTypeId === id);
      try {
        this.db.prepare(`
          UPDATE competition_vehicle_type SET display_name = ?, color = ?, sort_order = ? WHERE id = ?
        `).run(name, color, sortOrder, id);
      } catch (error) {
        if (error?.code?.startsWith?.("SQLITE_CONSTRAINT")) {
          throw httpError(`차량 유형 '${name}'이 이미 존재합니다.`, 409, "VEHICLE_TYPE_CONFLICT");
        }
        throw error;
      }
      const after = this.getVehicleType(id);
      const projections = {};
      for (const teamBefore of affectedTeams) {
        const teamAfter = this.getById(teamBefore.id);
        for (const [table, count] of Object.entries(updateCanonicalTeamProjections(this.db, teamBefore, teamAfter))) {
          projections[table] = (projections[table] || 0) + count;
        }
      }
      return { before, after, projections };
    })();
  }

  deleteVehicleType(idValue) {
    const id = requireId(idValue, "차량 유형 ID");
    return this.db.transaction(() => {
      const type = this.getVehicleType(id);
      if (!type) throw httpError("존재하지 않는 차량 유형입니다.", 404, "VEHICLE_TYPE_NOT_FOUND");
      assertCompetitionTeamWriteYear(type.year);
      if (this.db.prepare("SELECT 1 FROM competition_team WHERE vehicle_type_id = ? LIMIT 1").get(id)) {
        throw httpError("사용 중인 차량 유형은 삭제할 수 없습니다.", 409, "VEHICLE_TYPE_IN_USE");
      }
      this.db.prepare("DELETE FROM competition_vehicle_type WHERE id = ?").run(id);
      return type;
    })();
  }

  // Module-internal adapter while Queue/Score/Documents still consume their
  // established in-process shape. It is not mounted as a public Entry API.
  moduleEntries(yearValue, { includeInactive = false } = {}) {
    return Object.fromEntries(this.listTeams(yearValue, { includeInactive }).map((team) => [team.number, {
      id: team.id,
      teamId: team.id,
      univ: team.university,
      team: team.name,
      type: team.vehicleType,
      active: team.active,
    }]));
  }
}

export const teamValidation = { requireYear, requireNum };
