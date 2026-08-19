export function ensureInactiveTeamView(db) {
  const hasCanonicalTeams = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competition_team'",
  ).get();
  db.exec("DROP VIEW IF EXISTS competition_inactive_team");
  db.exec(hasCanonicalTeams
    ? `CREATE VIEW competition_inactive_team AS
         SELECT year, num AS team_num FROM competition_team WHERE active = 0`
    : `CREATE VIEW competition_inactive_team AS
         SELECT CAST(NULL AS INTEGER) AS year, CAST(NULL AS INTEGER) AS team_num WHERE 0`);
}

export function isTeamActive(db, year, teamNum) {
  const hasCanonicalTeams = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'competition_team'",
  ).get();
  // Isolated module tests do not create a second roster. The deployed
  // Competition runtime always takes the canonical branch.
  if (!hasCanonicalTeams) return true;
  const row = db.prepare(`
    SELECT active FROM competition_team
    WHERE year = ? AND num = ?
  `).get(year, teamNum);
  return row?.active === 1;
}
