import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setupTestEnv, TRUST_JWT } from "../helpers/test-utils.mjs";
import { currentCompetitionYear } from "../../shared/competition-year.mjs";
import { createK3sBackup } from "../../competition/scripts/create-k3s-backup.mjs";
import { validateCompetitionDatabaseFile } from
  "../../competition/scripts/validate-database.mjs";
import { validateSupportDatabaseFile } from
  "../../competition/scripts/validate-support-database.mjs";

setupTestEnv();

const { createCompetitionApp } = await import("../../competition/index.mjs");
const supportAppCreators = {
  auth: (await import("../../auth/index.mjs")).createAuthApp,
  calendar: (await import("../../calendar/index.mjs")).createCalendarApp,
  course: (await import("../../course/index.mjs")).createCourseApp,
  email: (await import("../../email/index.mjs")).createEmailApp,
};
const roots = [];
const unzipAvailable = spawnSync("unzip", ["-v"]).status === 0;

after(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsk-k3s-backup-"));
  roots.push(root);
  const dataRoot = path.join(root, "fsk");
  const competitionDir = path.join(dataRoot, "competition");
  const competitionDb = path.join(competitionDir, "competition.db");
  const uploads = path.join(competitionDir, "uploads");
  fs.mkdirSync(competitionDir, { recursive: true });

  const competition = createCompetitionApp({
    dbPath: competitionDb,
    uploadRoot: uploads,
    skipStaticValidation: true,
    validateUser: TRUST_JWT,
  });

  const storedRelative = "2026/team-1/submission-1/stored.pdf";
  const stored = path.join(uploads, storedRelative);
  const contents = "referenced upload";
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  fs.writeFileSync(stored, contents);
  fs.writeFileSync(path.join(uploads, "orphan.txt"), "must not be copied");

  const year = currentCompetitionYear();
  const team = competition.teams.createTeam(year, {
    number: 1,
    university: "Backup University",
    name: "Backup Team",
  });
  const sessionId = Number(competition.db.prepare(`
    INSERT INTO session
      (name, start_at, end_at, late_end_at, created_by, year)
    VALUES ('Backup', '2026-01-01', '2026-01-02', '2026-01-03', 'admin@example.com', ?)
  `).run(year).lastInsertRowid);
  const submissionId = Number(competition.db.prepare(`
    INSERT INTO submission
      (session_id, team_num, submitted_by, submitted_at, total_size, storage_dir, team_id)
    VALUES (?, ?, 'student@example.com', '2026-01-01', ?, ?, ?)
  `).run(sessionId, team.number, Buffer.byteLength(contents),
    "2026/team-1/submission-1", team.id).lastInsertRowid);
  competition.db.prepare(`
    INSERT INTO submission_file
      (submission_id, original_name, stored_name, size, mime_type)
    VALUES (?, 'report.pdf', 'stored.pdf', ?, 'application/pdf')
  `).run(submissionId, Buffer.byteLength(contents));
  competition.close();

  fs.writeFileSync(`${competitionDb}.migration.json`, '{"audit":"retained"}\n');
  fs.writeFileSync(path.join(competitionDir, ".cutover-active"), "complete\n");

  for (const [name, createApp] of Object.entries(supportAppCreators)) {
    const dbPath = path.join(dataRoot, name, `${name}.db`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const created = createApp({ dbPath, skipStaticValidation: true });
    created.db.close();
  }

  return { root, dataRoot, competitionDb, stored, storedRelative };
}

describe("k3s coordinated backup", () => {
  it("backs up the current databases and only referenced uploads", {
    skip: !unzipAvailable,
  }, async () => {
    const fixture = createFixture();
    const output = path.join(fixture.root, "fsk-data.zip");
    const before = Object.fromEntries([
      ["competition", fixture.competitionDb],
      ...Object.keys(supportAppCreators).map((name) => [
        name, path.join(fixture.dataRoot, name, `${name}.db`),
      ]),
    ].map(([name, target]) => [name, sha256(target)]));

    const result = await createK3sBackup(fixture.dataRoot, output);

    assert.equal(result.output, output);
    assert.equal(result.uploadCount, 1);
    assert.equal(result.sha256, sha256(output));
    const extracted = path.join(fixture.root, "extracted");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("unzip", ["-q", output, "-d", extracted]).status, 0);

    assert.equal(fs.readFileSync(path.join(extracted, "db", "required-databases.txt"),
      "utf8"), [
      "format=fsk-required-databases-v1",
      "competition.db",
      "auth.db",
      "calendar.db",
      "course.db",
      "email.db",
      "",
    ].join("\n"));
    validateCompetitionDatabaseFile(path.join(extracted, "db", "competition.db"));
    for (const name of Object.keys(supportAppCreators)) {
      validateSupportDatabaseFile(name, path.join(extracted, "db", `${name}.db`));
    }
    assert.equal(fs.readFileSync(path.join(extracted, "competition", "uploads",
      fixture.storedRelative), "utf8"), "referenced upload");
    assert.equal(fs.existsSync(path.join(extracted, "competition", "uploads",
      "orphan.txt")), false);
    assert.equal(fs.readFileSync(path.join(extracted, "competition",
      ".cutover-active"), "utf8"), "complete\n");

    for (const [name, digest] of Object.entries(before)) {
      const target = name === "competition" ? fixture.competitionDb :
        path.join(fixture.dataRoot, name, `${name}.db`);
      assert.equal(sha256(target), digest, `${name} source changed`);
    }
  });

  it("fails closed when a required database is missing", async () => {
    const fixture = createFixture();
    const output = path.join(fixture.root, "missing.zip");
    fs.rmSync(path.join(fixture.dataRoot, "email", "email.db"));

    await assert.rejects(createK3sBackup(fixture.dataRoot, output), /email database/);
    assert.equal(fs.existsSync(output), false);
  });

  it("rejects a referenced upload reached through a symlink", async () => {
    const fixture = createFixture();
    const output = path.join(fixture.root, "symlink.zip");
    const external = path.join(fixture.root, "external.pdf");
    fs.writeFileSync(external, "referenced upload");
    fs.rmSync(fixture.stored);
    fs.symlinkSync(external, fixture.stored);

    await assert.rejects(createK3sBackup(fixture.dataRoot, output), /symbolic link/);
    assert.equal(fs.existsSync(output), false);
  });
});
