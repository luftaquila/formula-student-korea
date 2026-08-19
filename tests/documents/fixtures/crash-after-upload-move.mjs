import fs from 'node:fs';
import path from 'node:path';
import { createDocumentsApp } from '../../../documents/index.mjs';
import {
  TRUST_JWT,
  makeAuthCookie,
  setupTestEnv,
} from '../../helpers/test-utils.mjs';

setupTestEnv();

const [dbPath, uploadsDir] = process.argv.slice(2);
if (!dbPath || !uploadsDir) process.exit(2);

const created = createDocumentsApp({
  dbPath,
  uploadsDir,
  validateUser: TRUST_JWT,
  enableNotificationScheduler: false,
  teamStore: {
    moduleEntries: () => ({ 1: { id: 1, num: 1, univ: 'Crash U', team: 'Crash T', active: true } }),
    getByNumber: () => ({ id: 1 }),
  },
  afterSubmissionFilesMoved: () => process.exit(77),
});

created.db.prepare(`
  INSERT INTO student_team (email, team_num, year)
  VALUES ('crash@test.invalid', 1, 2026)
`).run();
const sessionId = Number(created.db.prepare(`
  INSERT INTO session (name, notice, start_at, end_at, late_end_at, max_file_size, allowed_extensions, created_by, year)
  VALUES ('Crash', '', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '', 100000, 'pdf', 'test', 2026)
`).run().lastInsertRowid);
created.db.prepare('INSERT INTO session_team (session_id, team_num) VALUES (?, 1)').run(sessionId);

const server = created.app.listen(0, '127.0.0.1', async () => {
  try {
    const address = server.address();
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('crash')], { type: 'application/pdf' }), 'crash.pdf');
    await fetch(`http://127.0.0.1:${address.port}/api/sessions/${sessionId}/submit`, {
      method: 'POST',
      headers: {
        Cookie: makeAuthCookie({ email: 'crash@test.invalid', name: 'Crash', role: 'student' }),
      },
      body: form,
    });
    process.exit(3);
  } catch (error) {
    fs.writeFileSync(path.join(uploadsDir, 'child-error.txt'), error?.stack || String(error));
    process.exit(4);
  }
});
