import fs from 'fs';
import path from 'path';
import express from 'express'
import pinoHttp from 'pino-http';
import Database from 'better-sqlite3';

/* ============================================
   Database 초기화
   ============================================ */
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data', { recursive: true });
}

const db = new Database('./data/traffic.db');

db.exec(`CREATE TABLE IF NOT EXISTS controller (
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL
);`);

process.on('exit', () => db.close());
process.on('SIGHUP', () => process.exit(128 + 1));
process.on('SIGINT', () => process.exit(128 + 2));
process.on('SIGTERM', () => process.exit(128 + 15));

/* ============================================
   Express 앱 설정
   ============================================ */
const app = express();
app.use(express.json());
app.use(express.static('./web/dist'));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.headers.authorization) {
    req.headers.authuser = Buffer.from(req.headers.authorization.split(' ')[1], 'base64').toString('utf-8').split(':')[0];
  }
  next();
});
app.use(pinoHttp({
  stream: fs.createWriteStream('./data/traffic.log', { flags: 'a' }),
  customProps: (req, res) => ({ reqBody: req.body }),
}));

/* ============================================
   설정
   ============================================ */
const ENTRY_SERVER = process.env.ENTRY_SERVER || 'http://localhost:9000';

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateRecordName(name) {
  if (name === undefined || name === null || typeof name !== 'string' || name.trim() === '') {
    return { valid: false, error: '올바르지 않은 기록 이름입니다.' };
  }
  return { valid: true, value: name.trim() };
}

function validateRecordData(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: '올바르지 않은 기록 데이터입니다.' };
  }
  
  const required = ['time', 'type', 'entry', 'result'];
  for (const field of required) {
    if (data[field] === undefined) {
      return { valid: false, error: `필수 필드가 누락되었습니다: ${field}` };
    }
  }
  
  if (!data.entry || typeof data.entry !== 'object') {
    return { valid: false, error: '올바르지 않은 엔트리 데이터입니다.' };
  }
  
  return { valid: true };
}

function validateControllerData({ timestamp, data }) {
  if (timestamp === undefined || timestamp === null) {
    return { valid: false, error: '타임스탬프가 누락되었습니다.' };
  }
  if (data === undefined || data === null) {
    return { valid: false, error: '데이터가 누락되었습니다.' };
  }
  return { valid: true };
}

/* ============================================
   DB 헬퍼
   ============================================ */
function dbRun(fn) {
  try {
    return { success: true, result: fn() };
  } catch (e) {
    return { success: false, status: 500, error: `DB 오류: ${e}` };
  }
}

/* ============================================
   API 라우트: /api/entries (entry 서버 프록시)
   ============================================ */

// GET /api/entries - 모든 엔트리 조회
app.get('/api/entries', async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries`);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

// GET /api/entries/:num - 특정 엔트리 조회
app.get('/api/entries/:num', async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries/${req.params.num}`);
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

// POST /api/entries - 엔트리 추가
app.post('/api/entries', async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    res.status(201).send();
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

// DELETE /api/entries/:num - 엔트리 삭제
app.delete('/api/entries/:num', async (req, res) => {
  try {
    const response = await fetch(`${ENTRY_SERVER}/api/entries/${req.params.num}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      return res.status(response.status).send(await response.text());
    }
    res.status(200).send();
  } catch (e) {
    res.status(500).send(`Entry 서버 연결 오류: ${e}`);
  }
});

/* ============================================
   API 라우트: /api/records
   ============================================ */

// GET /api/records - 모든 기록 테이블 목록 조회
app.get('/api/records', (req, res) => {
  const result = dbRun(() => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'controller'").all();
    return tables.map(table => table.name);
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// GET /api/records/:name - 특정 기록 조회
app.get('/api/records/:name', (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = decodeURIComponent(validation.value);

  const result = dbRun(() => db.prepare(`SELECT * FROM '${name}'`).all());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/records - 새 기록 추가
app.post('/api/records', (req, res) => {
  const nameValidation = validateRecordName(req.body.name);
  if (!nameValidation.valid) {
    return res.status(400).send(nameValidation.error);
  }

  const dataValidation = validateRecordData(req.body.data);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const name = `FSK ${new Date().getFullYear()} ${nameValidation.value}`;
  const data = req.body.data;

  const result = dbRun(() => {
    db.transaction(() => {
      const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);

      if (!table) {
        db.exec(`CREATE TABLE IF NOT EXISTS '${name}' (
          time TEXT NOT NULL,
          num INTEGER NOT NULL,
          univ TEXT NOT NULL,
          team TEXT NOT NULL,
          lane TEXT,
          type TEXT NOT NULL,
          result INTEGER NOT NULL,
          detail TEXT
        );`);
      }

      db.prepare(`INSERT INTO '${name}' (time, num, univ, team, lane, type, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(data.time, data.entry.num, data.entry.univ, data.entry.team, data.lane, data.type, data.result, data.detail);
    })();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.status(201).send();
});

// DELETE /api/records/:name - 기록 테이블 삭제
app.delete('/api/records/:name', (req, res) => {
  const validation = validateRecordName(req.params.name);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const name = decodeURIComponent(validation.value);

  const result = dbRun(() => db.exec(`DROP TABLE IF EXISTS '${name}'`));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.status(200).send();
});

/* ============================================
   API 라우트: /api/controllers
   ============================================ */

// GET /api/controllers - 모든 컨트롤러 로그 조회
app.get('/api/controllers', (req, res) => {
  const result = dbRun(() => db.prepare('SELECT * FROM controller ORDER BY timestamp DESC').all());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.json(result.result);
});

// POST /api/controllers - 컨트롤러 로그 추가
app.post('/api/controllers', (req, res) => {
  const validation = validateControllerData(req.body);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const result = dbRun(() => 
    db.prepare('INSERT INTO controller (timestamp, data) VALUES (?, ?)').run(req.body.timestamp, req.body.data)
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.status(201).send();
});

// DELETE /api/controllers - 모든 컨트롤러 로그 삭제
app.delete('/api/controllers', (req, res) => {
  const result = dbRun(() => db.prepare('DELETE FROM controller').run());

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.status(200).send();
});

/* ============================================
   SPA Fallback
   ============================================ */
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.includes('.')) {
    const distPath = './web/dist';
    const indexPath = fs.existsSync(distPath)
      ? path.join(distPath, 'index.html')
      : './web/index.html';
    res.sendFile(path.resolve(indexPath));
  } else {
    next();
  }
});

/* ============================================
   서버 시작
   ============================================ */
app.listen(7000);
