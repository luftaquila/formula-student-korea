import { smsPrefix } from "../../../../shared/common/sms-template.mjs";

export function createRegistrationStore({ db, DEFAULT_SETTINGS, smsClient }) {
  function settingsForYear(year) {
    const row = db
      .prepare(
        `
      SELECT year, open, sms, notify_rank, updated_at
      FROM registration_settings WHERE year = ?
    `,
      )
      .get(year);
    return {
      year,
      open: row ? row.open === 1 : DEFAULT_SETTINGS.open,
      sms: row ? row.sms === 1 : DEFAULT_SETTINGS.sms,
      notifyRank: row ? row.notify_rank : DEFAULT_SETTINGS.notifyRank,
      smsAvailable: smsClient.isAvailable(),
      smsPrefix: smsPrefix(year).trimEnd(),
      updatedAt: row?.updated_at || null,
    };
  }

  function registrationRow(id) {
    return db
      .prepare(
        `
      SELECT q.id, q.team_id, q.phone, q.status, q.notified,
             q.registered_at, q.finished_at,
             t.year, t.num, t.univ, t.name, t.active
      FROM registration_queue q
      JOIN competition_team t ON t.id = q.team_id
      WHERE q.id = ?
    `,
      )
      .get(id);
  }

  function publicStatus(year) {
    const waiting = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
      WHERE t.year = ? AND q.status = 'waiting'
    `,
      )
      .get(year).count;
    return { year, open: settingsForYear(year).open, waiting };
  }

  function advanceTarget(year, rank) {
    return db
      .prepare(
        `
      SELECT q.id, q.team_id, q.phone, q.notified,
             t.year, t.num, t.univ, t.name, t.active
      FROM registration_queue q JOIN competition_team t ON t.id = q.team_id
      WHERE t.year = ? AND q.status = 'waiting'
      ORDER BY q.id LIMIT 1 OFFSET ?
    `,
      )
      .get(year, rank - 1);
  }

  return { settingsForYear, registrationRow, publicStatus, advanceTarget };
}
