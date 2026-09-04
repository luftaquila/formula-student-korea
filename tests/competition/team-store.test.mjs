import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("../../competition/node_modules/better-sqlite3");

import { currentCompetitionYear } from "../../shared/competition-year.mjs";
import { ensureCompetitionTeamSchema, TeamStore } from "../../competition/lib/team-store.mjs";

const YEAR = currentCompetitionYear();

describe("Competition TeamStore", () => {
  it("stores stable IDs without snapshot, finalize, version, or soft-delete state", () => {
    const db = new Database(":memory:");
    const store = new TeamStore(db);
    const type = store.createVehicleType(YEAR, { name: "C-Formula", color: "red" });
    const team = store.createTeam(YEAR, {
      number: 7, university: "A University", name: "Alpha", vehicleTypeId: type.id,
    });
    const updated = store.updateTeam(team.id, { number: 17, name: "Alpha 2" }).after;
    assert.equal(updated.id, team.id);
    assert.equal(updated.number, 17);
    assert.equal(store.getByNumber(YEAR, 7), null);
    assert.deepEqual(
      db.prepare("PRAGMA table_info(competition_team)").all().map(({ name }) => name),
      ["id", "year", "num", "univ", "name", "vehicle_type_id", "active", "created_at", "updated_at"],
    );
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'competition_year_version'").get(), undefined);
    for (const method of ["snapshot", "applySnapshot", "roster", "setFinalized", "version"]) {
      assert.equal(typeof store[method], "undefined");
    }
    db.close();
  });

  it("allows current and next-year roster preparation but rejects other-year mutations", () => {
    const db = new Database(":memory:");
    const store = new TeamStore(db);
    db.prepare(`INSERT INTO competition_team (year, num, univ, name) VALUES (?, 1, 'Old', 'Old')`).run(YEAR - 1);
    assert.equal(store.listTeams(YEAR - 1, { includeInactive: true })[0].name, "Old");
    assert.throws(
      () => store.updateTeam(1, { name: "Changed" }),
      (error) => error.status === 409 && error.code === "YEAR_READ_ONLY",
    );

    const futureType = store.createVehicleType(YEAR + 1, { name: "Future EV", color: "blue" });
    const futureTeam = store.createTeam(YEAR + 1, {
      number: 2, university: "B", name: "Future", vehicleTypeId: futureType.id,
    });
    assert.equal(store.updateTeam(futureTeam.id, { name: "Prepared" }).after.name, "Prepared");
    assert.equal(
      store.updateVehicleType(futureType.id, { name: "Future EV 2" }).after.name,
      "Future EV 2",
    );
    const unusedFutureType = store.createVehicleType(YEAR + 1, { name: "Unused", color: "red" });
    assert.equal(store.deleteVehicleType(unusedFutureType.id).year, YEAR + 1);

    assert.throws(
      () => store.createTeam(YEAR + 2, { number: 3, university: "C", name: "Too Future" }),
      (error) => error.status === 409 && error.code === "YEAR_READ_ONLY",
    );
    db.close();
  });

  it("imports a complete team list exactly once into an empty preparation year", () => {
    const db = new Database(":memory:");
    const store = new TeamStore(db);
    const preparationYear = YEAR + 1;
    const type = store.createVehicleType(preparationYear, { name: "E-Formula", color: "blue" });
    const imported = store.importInitial(preparationYear, { teams: [
      { number: 1, university: "A", name: "Alpha", vehicleTypeId: type.id },
      { number: 2, university: "B", name: "Beta", active: false },
    ] });
    assert.equal(imported.length, 2);
    assert.equal(imported[1].active, false);
    assert.throws(
      () => store.importInitial(preparationYear, { teams: [] }),
      (error) => error.status === 409 && error.code === "TEAM_IMPORT_NOT_EMPTY",
    );
    assert.equal(store.listTeams(preparationYear, { includeInactive: true }).length, 2);
    db.close();
  });

  it("keeps a rejected import atomic", () => {
    const db = new Database(":memory:");
    const store = new TeamStore(db);
    assert.throws(() => store.importInitial(YEAR, { teams: [
      { number: 3, university: "A", name: "A" },
      { number: 3, university: "B", name: "B" },
    ] }), /중복/);
    assert.deepEqual(store.listTeams(YEAR, { includeInactive: true }), []);
    db.close();
  });

  it("updates number projections by team_id and clears only transient state on deactivate", () => {
    const db = new Database(":memory:");
    const store = new TeamStore(db);
    const team = store.createTeam(YEAR, { number: 5, university: "A", name: "Alpha" });
    db.exec(`
      CREATE TABLE inspection_history (id INTEGER PRIMARY KEY, year INTEGER, num INTEGER, team_id INTEGER);
      CREATE TABLE inspection_queue (id INTEGER PRIMARY KEY, year INTEGER, num INTEGER, team_id INTEGER);
    `);
    db.prepare("INSERT INTO inspection_history VALUES (1, ?, 5, ?)").run(YEAR, team.id);
    db.prepare("INSERT INTO inspection_queue VALUES (1, ?, 5, ?)").run(YEAR, team.id);
    const result = store.updateTeam(team.id, { number: 9, active: false });
    assert.equal(db.prepare("SELECT num FROM inspection_history").get().num, 9);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM inspection_queue").get().count, 0);
    assert.deepEqual(result.clearedTransientState, { inspection_queue: 1 });
    assert.equal(store.getById(team.id).active, false);
    db.close();
  });

  it("preserves the Traffic event type while updating team display projections", () => {
    const db = new Database(":memory:");
    const store = new TeamStore(db);
    const type = store.createVehicleType(YEAR, { name: "EV", color: "blue" });
    const team = store.createTeam(YEAR, {
      number: 15, university: "Before University", name: "Before Team", vehicleTypeId: type.id,
    });
    db.exec(`
      CREATE TABLE record (
        name TEXT, num INTEGER, univ TEXT, team TEXT, type TEXT, team_id INTEGER
      );
    `);
    db.prepare("INSERT INTO record VALUES (?, 15, 'Before University', 'Before Team', '가속', ?)")
      .run(`FSK ${YEAR} 가속 1차`, team.id);

    store.updateTeam(team.id, { number: 25, university: "After University", name: "After Team" });

    assert.deepEqual(db.prepare("SELECT num, univ, team, type FROM record").get(), {
      num: 25,
      univ: "After University",
      team: "After Team",
      type: "가속",
    });
    db.close();
  });

  it("fails closed on the abandoned preview schema instead of maintaining it", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE competition_year_version (year INTEGER PRIMARY KEY, version INTEGER)");
    assert.throws(() => ensureCompetitionTeamSchema(db), /unsupported preview Competition schema/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'competition_team'").get(), undefined);
    db.close();
  });
});
