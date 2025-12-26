import fs from 'fs';
import express from 'express'
import pinoHttp from 'pino-http';
import Database from 'better-sqlite3';

/* ============================================
   Database 초기화
   ============================================ */
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data', { recursive: true });
}

const db = new Database('./data/entry.db');

db.exec(`CREATE TABLE IF NOT EXISTS entry (
  num INTEGER PRIMARY KEY,
  univ TEXT NOT NULL,
  team TEXT NOT NULL
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
  stream: fs.createWriteStream('./data/entry.log', { flags: 'a' }),
  customProps: (req, res) => ({ reqBody: req.body }),
}));

/* ============================================
   Validation 헬퍼
   ============================================ */
function validateEntryNum(num) {
  const parsed = Number(num);
  if (num === '' || num === undefined || Number.isNaN(parsed) || parsed < 0) {
    return { valid: false, error: '올바르지 않은 엔트리 번호입니다.' };
  }
  return { valid: true, value: parsed };
}

function validateEntryData({ univ, team }) {
  if (univ === undefined || univ.trim() === '') {
    return { valid: false, error: '올바르지 않은 학교명입니다.' };
  }
  if (team === undefined || team.trim() === '') {
    return { valid: false, error: '올바르지 않은 팀명입니다.' };
  }
  return { valid: true, univ: univ.trim(), team: team.trim() };
}

function validateBulkData(data) {
  let parsed;
  
  try {
    parsed = typeof data === 'string' ? JSON.parse(data) : data;
  } catch (e) {
    return { valid: false, error: `JSON 파일을 읽을 수 없습니다: ${e}` };
  }

  if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
    return { valid: false, error: '올바르지 않은 JSON 형식입니다.' };
  }

  for (const key in parsed) {
    if (!/^\d+$/.test(key)) {
      return { valid: false, error: '올바르지 않은 JSON 형식입니다.' };
    }

    const value = parsed[key];
    if (typeof value !== 'object' || value === null) {
      return { valid: false, error: '올바르지 않은 JSON 형식입니다.' };
    }

    const keys = Object.keys(value);
    if (!keys.includes('univ') || !keys.includes('team')) {
      return { valid: false, error: '올바르지 않은 JSON 형식입니다.' };
    }
  }

  return { valid: true, data: parsed };
}

/* ============================================
   DB 헬퍼
   ============================================ */
function dbRun(fn) {
  try {
    return { success: true, result: fn() };
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return { success: false, status: 400, error: '이미 존재하는 엔트리 번호입니다.' };
    }
    return { success: false, status: 500, error: `DB 오류: ${e}` };
  }
}

/* ============================================
   API 라우트: /api/entries
   ============================================ */

// GET /api/entries - 모든 엔트리 조회
app.get('/api/entries', (req, res) => {
  const result = dbRun(() => {
    const data = {};
    for (const row of db.prepare("SELECT * FROM entry").all()) {
      data[row.num] = { univ: row.univ, team: row.team };
    }
    return data;
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (req.query.download !== undefined) {
    res.setHeader('Content-Disposition', 'attachment; filename="entry.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(result.result, null, 2));
  } else {
    res.json(result.result);
  }
});

// GET /api/entries/:num - 특정 엔트리 조회
app.get('/api/entries/:num', (req, res) => {
  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const result = dbRun(() => db.prepare("SELECT * FROM entry WHERE num = ?").get(numValidation.value));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (!result.result) {
    return res.status(404).send('존재하지 않는 엔트리 번호입니다.');
  }

  res.json(result.result);
});

// POST /api/entries - 새 엔트리 추가
app.post('/api/entries', (req, res) => {
  const numValidation = validateEntryNum(req.body.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const dataValidation = validateEntryData(req.body);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const result = dbRun(() => 
    db.prepare("INSERT INTO entry (num, univ, team) VALUES (?, ?, ?)")
      .run(numValidation.value, dataValidation.univ, dataValidation.team)
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.status(201).send();
});

// PATCH /api/entries/:num - 엔트리 수정
app.patch('/api/entries/:num', (req, res) => {
  const prevNumValidation = validateEntryNum(req.params.num);
  if (!prevNumValidation.valid) {
    return res.status(400).send(prevNumValidation.error);
  }

  const newNumValidation = validateEntryNum(req.body.num);
  if (!newNumValidation.valid) {
    return res.status(400).send(newNumValidation.error);
  }

  const dataValidation = validateEntryData(req.body);
  if (!dataValidation.valid) {
    return res.status(400).send(dataValidation.error);
  }

  const prevNum = prevNumValidation.value;
  const newNum = newNumValidation.value;
  const numChanged = prevNum !== newNum;

  if (numChanged) {
    const numResult = dbRun(() => db.prepare("UPDATE entry SET num = ? WHERE num = ?").run(newNum, prevNum));

    if (!numResult.success) {
      return res.status(numResult.status).send(numResult.error);
    }

    if (!numResult.result.changes) {
      return res.status(404).send('존재하지 않는 엔트리 번호입니다.');
    }
  }

  const result = dbRun(() => 
    db.prepare("UPDATE entry SET univ = ?, team = ? WHERE num = ?")
      .run(dataValidation.univ, dataValidation.team, newNum)
  );

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (!result.result.changes) {
    return res.status(404).send('존재하지 않는 엔트리 번호입니다.');
  }

  res.status(200).send();
});

// DELETE /api/entries/:num - 엔트리 삭제
app.delete('/api/entries/:num', (req, res) => {
  const numValidation = validateEntryNum(req.params.num);
  if (!numValidation.valid) {
    return res.status(400).send(numValidation.error);
  }

  const result = dbRun(() => db.prepare("DELETE FROM entry WHERE num = ?").run(numValidation.value));

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  if (!result.result.changes) {
    return res.status(404).send('존재하지 않는 엔트리 번호입니다.');
  }

  res.status(200).send();
});

// POST /api/entries/bulk - 엔트리 일괄 업로드 (DB 교체)
app.post('/api/entries/bulk', (req, res) => {
  const validation = validateBulkData(req.body.data);
  if (!validation.valid) {
    return res.status(400).send(validation.error);
  }

  const result = dbRun(() => {
    db.transaction(() => {
      db.prepare("DELETE FROM entry").run();
      const query = db.prepare("INSERT INTO entry (num, univ, team) VALUES (?, ?, ?)");
      for (const [k, v] of Object.entries(validation.data)) {
        query.run(Number(k), v.univ, v.team);
      }
    })();
  });

  if (!result.success) {
    return res.status(result.status).send(result.error);
  }

  res.status(200).send();
});

/* ============================================
   서버 시작
   ============================================ */
app.listen(9000);
