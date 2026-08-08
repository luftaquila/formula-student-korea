import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('../../auth/node_modules/express');

import { createClient, startServer, stopServer } from '../helpers/test-utils.mjs';
import { registerTeamStatusSnapshotRoute } from '../../shared/team-status.mjs';

// ─── team-status 스냅샷 라우트 ─────────────────────────────────────────────
// 이 라우트가 죽으면 entry의 정합성 점검이 조용히 저하되므로, dbRun 실패는 서빙 쪽에도
// team.status_snapshot warn으로 흔적이 남아야 한다. dbRun을 stub으로 주입해 실패를 강제한다.
describe('registerTeamStatusSnapshotRoute', () => {
  const servers = [];

  after(async () => {
    for (const s of servers) await stopServer(s);
  });

  function makeLogger() {
    const warns = [];
    return {
      warns,
      warn: (req, action, detail, target) => warns.push({ action, detail, target }),
      log: () => {},
    };
  }

  async function createSnapshotApp({ dbRun, logger }) {
    const app = express();
    registerTeamStatusSnapshotRoute(app, {
      db: null, // dbRun stub이 fn을 실행하지 않으므로 실제 DB는 불필요
      dbRun,
      logger,
      requireInternalRequest: () => true,
    });
    const { server, baseUrl } = await startServer(app);
    servers.push(server);
    return createClient(baseUrl);
  }

  it('warns team.status_snapshot with error and cause on dbRun failure', async () => {
    const logger = makeLogger();
    const client = await createSnapshotApp({
      dbRun: () => ({ success: false, status: 500, error: 'x', cause: 'y' }),
      logger,
    });

    const res = await client.get('/api/internal/team-status?year=2026');
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'x');

    assert.equal(logger.warns.length, 1);
    const warn = logger.warns[0];
    assert.equal(warn.action, 'team.status_snapshot');
    assert.equal(warn.detail.error, 'x');
    assert.equal(warn.detail.cause, 'y');
    assert.equal(warn.detail.year, 2026);
  });

  it('serves the snapshot without logging when dbRun succeeds', async () => {
    const logger = makeLogger();
    const client = await createSnapshotApp({
      dbRun: () => ({
        success: true,
        result: [
          { team_num: 1, active: 1, revision: 2 },
          { team_num: 3, active: 0, revision: 5 },
        ],
      }),
      logger,
    });

    const res = await client.get('/api/internal/team-status?year=2026');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      1: { active: true, revision: 2 },
      3: { active: false, revision: 5 },
    });
    assert.equal(logger.warns.length, 0, 'the healthy path must stay silent');
  });
});
