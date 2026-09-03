import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const express = require('../../email/node_modules/express/index.js');
const Database = require('../../email/node_modules/better-sqlite3');
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';
import { createEmailApp } from '../../email/index.mjs';

/* ============================================
   Mock Auth Server
   ============================================ */
const MOCK_USERS = [
  { email: 'student@test.com', name: 'Student', role: 'student', active: 1 },
  { email: 'official@test.com', name: 'Official', role: 'official', active: 1 },
  { email: 'messaging@test.com', name: 'Messaging Operator', role: 'official', active: 1,
    permissions: ['messaging.operate'] },
  { email: 'admin@test.com', name: 'Admin', role: 'admin', realname: 'Admin Kim', active: 1 },
  { email: 'inactive@test.com', name: 'Inactive', role: 'student', active: 0 },
];

function createMockAuthServer() {
  const app = express();
  app.use(express.json());
  app.get('/api/users/access/:email', (req, res) => {
    const user = MOCK_USERS.find(u => u.email === decodeURIComponent(req.params.email));
    if (!user) return res.status(404).json({ error: 'not found' });
    res.json({
      id: MOCK_USERS.indexOf(user) + 1,
      role: user.role,
      permissions: user.permissions || [],
      accessRevision: 0,
    });
  });
  app.get('/api/users', (req, res) => {
    res.json(MOCK_USERS.map(u => ({ ...u, protected: false })));
  });
  return app;
}

/* ============================================
   Mock Brevo API
   ============================================ */
let brevoCallLog = [];
let brevoAccountResponse = { plan: [{ type: "free", creditsType: "sendLimit", credits: 300 }] };
let brevoSendResponse = { messageId: '<test-msg-id>' };
let brevoSendStatus = 201;
// 특정 수신자만 실패시키기 위한 집합 (동시성 풀 per-index 매핑 검증용)
let brevoFailRecipients = new Set();

function createMockFetch(authBaseUrl) {
  return async function mockFetch(url, options) {
    const urlStr = typeof url === 'string' ? url : url.toString();

    // Brevo account endpoint
    if (urlStr.includes('/v3/account')) {
      brevoCallLog.push({ type: 'account', url: urlStr });
      return new Response(JSON.stringify(brevoAccountResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Brevo send endpoint
    if (urlStr.includes('/v3/smtp/email')) {
      brevoCallLog.push({ type: 'send', url: urlStr, body: options?.body });
      let toEmail = null;
      try { toEmail = JSON.parse(options?.body || '{}').to?.[0]?.email; } catch { /* ignore */ }
      if (toEmail && brevoFailRecipients.has(toEmail)) {
        return new Response(JSON.stringify({ message: `rejected ${toEmail}` }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(brevoSendResponse), {
        status: brevoSendStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Auth server requests — proxy to mock auth
    if (urlStr.includes('/api/users')) {
      return fetch(urlStr.replace(/http:\/\/[^/]+/, authBaseUrl), options);
    }

    throw new Error(`Unexpected fetch: ${urlStr}`);
  };
}

/* ============================================
   Setup
   ============================================ */
setupTestEnv();

let server, baseUrl, client, db, dbPath;
let mockAuthServer;

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });
const messagingCookie = makeAuthCookie({ email: 'messaging@test.com', name: 'Messaging Operator', role: 'official' });
const studentCookie = makeAuthCookie({ email: 'student@test.com', name: 'Student', role: 'student' });

before(async () => {
  const mockApp = createMockAuthServer();
  const mockStarted = await startServer(mockApp);
  mockAuthServer = mockStarted.server;
  process.env.AUTH_SERVER = mockStarted.baseUrl;

  dbPath = tmpDbPath();
  const result = createEmailApp({
    dbPath,
    fetchFn: createMockFetch(mockStarted.baseUrl),
  });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);

  // Reset brevo state
  brevoCallLog = [];
});

after(async () => {
  await stopServer(server);
  await stopServer(mockAuthServer);
  db.close();
  cleanup(dbPath);
});

/* ============================================
   Tests
   ============================================ */

describe('email_log migration', () => {
  it('backfills legacy recipients even when recipient column was already added before a crash', () => {
    const legacyPath = tmpDbPath();
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE email_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        recipients TEXT,
        recipient_count INTEGER,
        recipient TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'sent',
        error TEXT,
        message_id TEXT,
        html_content TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        sent_at TEXT NOT NULL DEFAULT '2026-01-01 10:00:00',
        sent_by TEXT
      );
      INSERT INTO email_log (subject, recipients, recipient_count, recipient)
      VALUES ('legacy', '["legacy1@test.com","legacy2@test.com"]', 2, '');
    `);
    legacyDb.close();

    const migrated = createEmailApp({
      dbPath: legacyPath,
      fetchFn: createMockFetch(process.env.AUTH_SERVER),
    });
    try {
      const row = migrated.db.prepare("SELECT recipient FROM email_log WHERE subject = 'legacy'").get();
      assert.equal(row.recipient, 'legacy1@test.com');
      const cols = migrated.db.prepare("PRAGMA table_info(email_log)").all().map(c => c.name);
      assert.equal(cols.includes('recipients'), false);
      assert.equal(cols.includes('recipient_count'), false);
    } finally {
      migrated.db.close();
      cleanup(legacyPath);
    }
  });
});

describe('Email API', () => {

  describe('GET /api/health', () => {
    it('returns ok', async () => {
      const res = await client.get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'ok');
    });
  });

  describe('Auth enforcement', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await client.get('/api/stats');
      assert.equal(res.status, 401);
    });

    it('rejects non-admin users', async () => {
      const res = await client.get('/api/stats', { cookie: studentCookie });
      assert.equal(res.status, 403);
    });

    it('rejects officials without a messaging grant', async () => {
      const res = await client.get('/api/stats', { cookie: officialCookie });
      assert.equal(res.status, 403);
    });

    it('allows officials with messaging.operate', async () => {
      const res = await client.get('/api/stats', { cookie: messagingCookie });
      assert.equal(res.status, 200);
    });

    it('allows admin users', async () => {
      const res = await client.get('/api/stats', { cookie: adminCookie });
      assert.equal(res.status, 200);
    });
  });

  describe('SPA gating (non-API paths)', () => {
    // The email SPA requires messaging.operate, so ungranted users are redirected
    // instead of being served a shell
    // whose every API call then 401/403s.
    it('redirects unauthenticated users away from the SPA', async () => {
      const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
      assert.equal(res.status, 302);
    });

    it('redirects non-admin users away from the SPA', async () => {
      const res = await fetch(`${baseUrl}/`, { redirect: 'manual', headers: { Cookie: studentCookie } });
      assert.equal(res.status, 302);
    });

    it('lets admin users through the SPA gate', async () => {
      const res = await fetch(`${baseUrl}/`, { redirect: 'manual', headers: { Cookie: adminCookie } });
      assert.notEqual(res.status, 302);
    });
  });

  describe('GET /api/config', () => {
    it('returns config with masked secrets', async () => {
      const res = await client.get('/api/config', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok('brevo_api_key' in data);
      assert.ok('brevo_sender_name' in data);
      assert.ok('naver_cloud_access_key' in data);
    });
  });

  describe('PUT /api/config', () => {
    it('updates config values', async () => {
      const res = await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [
          { key: 'brevo_api_key', value: 'xkeysib-test-api-key-1234' },
          { key: 'brevo_sender_name', value: 'FSK Test' },
          { key: 'brevo_sender_email', value: 'test@fsk.kr' },
        ]},
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.updated.includes('brevo_api_key'));
      assert.ok(data.updated.includes('brevo_sender_name'));
    });

    it('masks secrets in GET after update', async () => {
      const res = await client.get('/api/config', { cookie: adminCookie });
      const data = await res.json();
      assert.ok(data.brevo_api_key.startsWith('****'));
      assert.ok(data.brevo_api_key.endsWith('1234'));
      assert.equal(data.brevo_sender_name, 'FSK Test');
    });

    it('skips empty values (no change)', async () => {
      const res = await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'brevo_api_key', value: '' }] },
      });
      const data = await res.json();
      assert.equal(data.updated.length, 0);
    });

    it('skips masked placeholder values', async () => {
      // GET returns masked value like "****1234"
      const getRes = await client.get('/api/config', { cookie: adminCookie });
      const data = await getRes.json();
      const maskedApiKey = data.brevo_api_key; // "****1234"
      assert.ok(maskedApiKey.startsWith('****'));

      // PUT with masked value should skip it (not overwrite real key)
      const res = await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'brevo_api_key', value: maskedApiKey }] },
      });
      const putData = await res.json();
      assert.ok(!putData.updated.includes('brevo_api_key'));

      // Verify real key is still intact
      const verify = await client.get('/api/config', { cookie: adminCookie });
      const verifyData = await verify.json();
      assert.ok(verifyData.brevo_api_key.startsWith('****'));
      assert.ok(verifyData.brevo_api_key.endsWith('1234'));
    });

    it('rejects unknown keys', async () => {
      const res = await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'unknown_key', value: 'val' }] },
      });
      const data = await res.json();
      assert.equal(data.updated.length, 0);
    });
  });

  describe('POST /api/config/reset', () => {
    before(async () => {
      // Ensure SMS config is set
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [
          { key: 'naver_cloud_access_key', value: 'reset-test-key' },
          { key: 'phone_number_sms_sender', value: '01099998888' },
        ]},
      });
    });

    it('resets SMS config group', async () => {
      const res = await client.post('/api/config/reset', {
        cookie: adminCookie,
        body: { group: 'sms' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.reset.includes('naver_cloud_access_key'));

      // Verify values are cleared
      const configRes = await client.get('/api/config', { cookie: adminCookie });
      const config = await configRes.json();
      assert.equal(config.naver_cloud_access_key, '');
      assert.equal(config.phone_number_sms_sender, '');
    });

    it('rejects invalid group', async () => {
      const res = await client.post('/api/config/reset', {
        cookie: adminCookie,
        body: { group: 'invalid' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('email_enabled toggle', () => {
    it('blocks send when email is disabled', async () => {
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'email_enabled', value: 'FALSE' }] },
      });

      // Re-set brevo config since SMS reset may have cleared it
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [
          { key: 'brevo_api_key', value: 'xkeysib-test-api-key-1234' },
          { key: 'brevo_sender_email', value: 'test@fsk.kr' },
        ]},
      });

      brevoSendStatus = 201;
      brevoSendResponse = { messageId: '<disabled-test>' };
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: { subject: 'Disabled', htmlContent: '<p>Test</p>', recipients: ['a@test.com'] },
      });
      assert.equal(res.status, 503);

      // Re-enable
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'email_enabled', value: 'TRUE' }] },
      });
    });
  });

  describe('GET /api/stats', () => {
    it('returns stats with zero counts initially', async () => {
      const res = await client.get('/api/stats', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(typeof data.sent, 'number');
      assert.equal(typeof data.errors, 'number');
      assert.equal(typeof data.totalSent, 'number');
      assert.equal(typeof data.totalErrors, 'number');
    });
  });

  describe('GET /api/quota', () => {
    it('returns remaining quota from Brevo', async () => {
      const res = await client.get('/api/quota', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.remaining, 300);
    });
  });

  describe('POST /api/send', () => {
    before(() => {
      brevoCallLog = [];
      brevoSendStatus = 201;
      brevoSendResponse = { messageId: '<test-123>' };
    });

    it('sends email successfully', async () => {
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: {
          subject: 'Test Email',
          htmlContent: '<p>Hello</p>',
          recipients: ['user1@test.com', 'user2@test.com'],
        },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.success);
      assert.equal(data.messageId, '<test-123>');

      // Verify Brevo was called per recipient
      const sendCalls = brevoCallLog.filter(c => c.type === 'send');
      assert.equal(sendCalls.length, 2);
    });

    it('records per-recipient email log rows', async () => {
      const res = await client.get('/api/emails', { cookie: adminCookie });
      const data = await res.json();
      const logs = data.rows.filter(r => r.subject === 'Test Email');
      assert.equal(logs.length, 2);
      assert.ok(logs.every(r => r.status === 'sent'));
      assert.ok(logs.every(r => !Object.hasOwn(r, 'html_content')));
      const recipients = logs.map(r => r.recipient).sort();
      assert.deepEqual(recipients, ['user1@test.com', 'user2@test.com']);
      assert.equal(logs[0].source, 'manual');
    });

    it('returns html content only from email detail endpoint', async () => {
      const listRes = await client.get('/api/emails', { cookie: adminCookie });
      const list = await listRes.json();
      const log = list.rows.find(r => r.subject === 'Test Email');
      assert.ok(log);
      assert.ok(!Object.hasOwn(log, 'html_content'));

      const detailRes = await client.get(`/api/emails/${log.id}`, { cookie: adminCookie });
      assert.equal(detailRes.status, 200);
      const detail = await detailRes.json();
      assert.equal(detail.html_content, '<p>Hello</p>');
    });

    it('rejects missing fields', async () => {
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: { subject: 'No content' },
      });
      assert.equal(res.status, 400);
    });

    it('rejects empty recipients array', async () => {
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: { subject: 'Empty', htmlContent: '<p>Test</p>', recipients: [] },
      });
      assert.equal(res.status, 400);
    });

    it('rejects invalid email format in recipients', async () => {
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: { subject: 'Bad Email', htmlContent: '<p>Test</p>', recipients: ['not-an-email', 'valid@test.com'] },
      });
      assert.equal(res.status, 400);
      const text = await res.text();
      assert.ok(text.includes('not-an-email'));
    });

    it('ignores non-string config values without crashing', async () => {
      const res = await client.put('/api/config', {
        cookie: adminCookie,
        body: {
          configs: [
            { key: 'brevo_sender_name', value: 123 },
            { key: 'email_enabled', value: { nested: true } },
          ],
        },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(!data.updated.includes('brevo_sender_name'));
      assert.ok(!data.updated.includes('email_enabled'));
    });

    it('rejects when quota is insufficient', async () => {
      brevoAccountResponse = { plan: [{ type: "free", creditsType: "sendLimit", credits: 1 }] };
      // 쿼터는 apiKey 단위 60초 캐시라, 새 키로 교체해 재조회를 강제한다
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'brevo_api_key', value: 'xkeysib-quota-test-key-0000' }] },
      });
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: {
          subject: 'Too many',
          htmlContent: '<p>Hello</p>',
          recipients: ['a@test.com', 'b@test.com', 'c@test.com'],
        },
      });
      assert.equal(res.status, 400);
      const text = await res.text();
      assert.ok(text.includes('전송 가능한 메일 수'));
      // Restore
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'brevo_api_key', value: 'xkeysib-test-api-key-1234' }] },
      });
      brevoAccountResponse = { plan: [{ type: "free", creditsType: "sendLimit", credits: 300 }] };
    });

    it('caches quota lookups per api key for consecutive sends', async () => {
      // 새 키로 캐시를 비운 뒤 연속 발송 — /account 조회는 1회여야 한다
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'brevo_api_key', value: 'xkeysib-cache-test-key-0000' }] },
      });
      brevoCallLog = [];
      for (const recipient of ['q1@test.com', 'q2@test.com']) {
        const res = await client.post('/api/send', {
          cookie: adminCookie,
          body: { subject: 'Cache Test', htmlContent: '<p>Hi</p>', recipients: [recipient] },
        });
        assert.equal(res.status, 200);
      }
      const accountCalls = brevoCallLog.filter(c => c.type === 'account');
      assert.equal(accountCalls.length, 1);
      // Restore
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [{ key: 'brevo_api_key', value: 'xkeysib-test-api-key-1234' }] },
      });
    });

    it('processes every recipient when the count exceeds the concurrency pool', async () => {
      // 기본 quota 300 → 게이트 통과. 7 > SEND_CONCURRENCY(5)라 워커가 루프를 재진입해야 하고,
      // while→if나 nextIndex off-by-one이면 일부 수신자가 누락/중복된다.
      brevoCallLog = [];
      const recipients = Array.from({ length: 7 }, (_, i) => `pool${i}@test.com`);
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: { subject: 'Pool Drain', htmlContent: '<p>Hi</p>', recipients },
      });
      assert.equal(res.status, 200);
      assert.equal(brevoCallLog.filter(c => c.type === 'send').length, 7);
      const list = await (await client.get('/api/emails', { cookie: adminCookie })).json();
      const rows = list.rows.filter(r => r.subject === 'Pool Drain');
      assert.equal(rows.length, 7);
      assert.ok(rows.every(r => r.status === 'sent'));
      const logged = rows.map(r => r.recipient).sort();
      assert.deepEqual(logged, recipients.slice().sort());
    });

    it('maps per-recipient success/failure correctly under partial failure', async () => {
      // 중간 수신자 하나만 실패 → results[i]↔recipients[i] 매핑과 부분 실패 집계 검증
      brevoCallLog = [];
      brevoFailRecipients = new Set(['mix2@test.com']);
      const recipients = ['mix0@test.com', 'mix1@test.com', 'mix2@test.com', 'mix3@test.com'];
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: { subject: 'Mixed Outcome', htmlContent: '<p>Hi</p>', recipients },
      });
      // successCount > 0 → 200 (부분 성공)
      assert.equal(res.status, 200);
      const list = await (await client.get('/api/emails', { cookie: adminCookie })).json();
      const rows = list.rows.filter(r => r.subject === 'Mixed Outcome');
      assert.equal(rows.length, 4);
      const byRecipient = Object.fromEntries(rows.map(r => [r.recipient, r.status]));
      assert.equal(byRecipient['mix2@test.com'], 'error', 'the failed recipient must be logged as error');
      for (const ok of ['mix0@test.com', 'mix1@test.com', 'mix3@test.com']) {
        assert.equal(byRecipient[ok], 'sent', `${ok} must be logged as sent`);
      }
      brevoFailRecipients = new Set();
    });

    it('records error when Brevo returns failure', async () => {
      brevoSendStatus = 400;
      brevoSendResponse = { message: 'Invalid email' };
      const res = await client.post('/api/send', {
        cookie: adminCookie,
        body: {
          subject: 'Fail Email',
          htmlContent: '<p>Fail</p>',
          recipients: ['bad@test.com'],
        },
      });
      assert.equal(res.status, 400);

      // Check log has error entry
      const logRes = await client.get('/api/emails?status=error', { cookie: adminCookie });
      const logData = await logRes.json();
      assert.ok(logData.rows.some(r => r.subject === 'Fail Email' && r.status === 'error'));

      // Restore
      brevoSendStatus = 201;
      brevoSendResponse = { messageId: '<test-restore>' };
    });
  });

  describe('POST /api/internal/send', () => {
    it('sends via internal API with service header', async () => {
      brevoCallLog = [];
      const res = await client.post('/api/internal/send', {
        headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
        body: {
          subject: 'Internal Notification',
          htmlContent: '<p>Internal</p>',
          recipients: ['admin@test.com'],
          source: 'auth',
        },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.success);
    });

    it('records source in email log', async () => {
      const res = await client.get('/api/emails', { cookie: adminCookie });
      const data = await res.json();
      const internal = data.rows.find(r => r.source === 'auth');
      assert.ok(internal);
      assert.equal(internal.subject, 'Internal Notification');
    });

    it('rejects without internal header or admin cookie', async () => {
      const res = await client.post('/api/internal/send', {
        body: {
          subject: 'Unauthorized',
          htmlContent: '<p>No auth</p>',
          recipients: ['admin@test.com'],
        },
      });
      assert.equal(res.status, 401);
    });

    it('does NOT emit email.send info log on internal success (noise reduction)', async () => {
      const subject = 'Quiet Internal ' + Date.now();
      const res = await client.post('/api/internal/send', {
        headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
        body: {
          subject,
          htmlContent: '<p>Quiet</p>',
          recipients: ['admin@test.com'],
          source: 'documents',
        },
      });
      assert.equal(res.status, 200);

      const logsRes = await client.get('/api/logs?action=email.send', { cookie: adminCookie });
      const logsData = await logsRes.json();
      const matches = (logsData.logs || []).filter(
        r => r.action === 'email.send' && r.level === 'info' && r.detail && r.detail.includes(subject),
      );
      assert.equal(matches.length, 0, 'internal success must not produce email.send info log');
    });

    it('still emits email.send warn on internal full-failure', async () => {
      brevoSendStatus = 400;
      brevoSendResponse = { message: 'Invalid email' };
      const subject = 'Fail Internal ' + Date.now();
      const res = await client.post('/api/internal/send', {
        headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
        body: {
          subject,
          htmlContent: '<p>Fail</p>',
          recipients: ['bad@test.com'],
          source: 'documents',
        },
      });
      assert.equal(res.status, 400);

      const logsRes = await client.get('/api/logs?action=email.send&level=warn', { cookie: adminCookie });
      const logsData = await logsRes.json();
      const matches = (logsData.logs || []).filter(
        r => r.action === 'email.send' && r.level === 'warn' && r.detail && r.detail.includes(subject),
      );
      assert.ok(matches.length >= 1, 'full-failure must still produce email.send warn log');

      // Restore
      brevoSendStatus = 201;
      brevoSendResponse = { messageId: '<test-restore>' };
    });
  });

  describe('GET /api/recipients', () => {
    it('returns all users from auth with active field', async () => {
      const res = await client.get('/api/recipients', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.length >= 5);
      assert.ok(data.every(u => u.email && u.role && typeof u.active !== 'undefined'));
      const inactive = data.find(u => u.email === 'inactive@test.com');
      assert.ok(inactive);
      assert.equal(inactive.active, 0);
    });
  });

  describe('GET /api/internal/sms-config', () => {
    before(async () => {
      // Set SMS config values
      await client.put('/api/config', {
        cookie: adminCookie,
        body: { configs: [
          { key: 'naver_cloud_access_key', value: 'test-access-key' },
          { key: 'naver_cloud_secret_key', value: 'test-secret-key' },
          { key: 'naver_cloud_sms_service_id', value: 'test-svc-id' },
          { key: 'phone_number_sms_sender', value: '01012345678' },
        ]},
      });
    });

    it('returns unmasked SMS config with internal header', async () => {
      const res = await client.get('/api/internal/sms-config', {
        headers: { 'X-Internal-Service': TEST_INTERNAL_SECRET },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.naver_cloud_access_key, 'test-access-key');
      assert.equal(data.naver_cloud_secret_key, 'test-secret-key');
      assert.equal(data.naver_cloud_sms_service_id, 'test-svc-id');
      assert.equal(data.phone_number_sms_sender, '01012345678');
    });

    it('rejects without auth', async () => {
      const res = await client.get('/api/internal/sms-config');
      assert.equal(res.status, 401);
    });
  });

  describe('GET /api/emails (pagination)', () => {
    it('supports limit and offset', async () => {
      const res = await client.get('/api/emails?limit=2&offset=0', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.rows.length, 2);
      assert.ok(data.total >= 1);
    });

    it('supports status filter', async () => {
      const res = await client.get('/api/emails?status=sent', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.rows.length > 0);
      assert.ok(data.rows.every(r => r.status === 'sent'));
    });
  });

  describe('POST /api/test-email', () => {
    it('sends test email successfully', async () => {
      brevoCallLog = [];
      brevoSendStatus = 201;
      brevoSendResponse = { messageId: '<test-email-id>' };
      const res = await client.post('/api/test-email', {
        cookie: adminCookie,
        body: { recipient: 'test@example.com' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.success);
      const sendCalls = brevoCallLog.filter(c => c.type === 'send');
      assert.ok(sendCalls.length >= 1);
    });

    it('rejects without recipient', async () => {
      const res = await client.post('/api/test-email', {
        cookie: adminCookie,
        body: {},
      });
      assert.equal(res.status, 400);
    });
  });

  describe('POST /api/test-sms', () => {
    it('rejects without recipient', async () => {
      const res = await client.post('/api/test-sms', {
        cookie: adminCookie,
        body: {},
      });
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/logs', () => {
    it('returns system logs for admin', async () => {
      const res = await client.get('/api/logs', { cookie: adminCookie });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.service, 'email');
      assert.ok(Array.isArray(data.logs));
      assert.equal(typeof data.total, 'number');
    });
  });
});
