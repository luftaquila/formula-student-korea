import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDbPath, cleanup } from '../helpers/test-utils.mjs';

const require = createRequire(import.meta.url);
const Database = require('../../auth/node_modules/better-sqlite3');
import { createDatabase, addColumn, parseLegacyTimestamp, rebuildTable } from '../../shared/server/db-setup.mjs';

let dbPath, db;

describe('createDatabase', () => {
  before(() => {
    dbPath = tmpDbPath();
    db = createDatabase(Database, dbPath);
  });

  after(() => {
    if (db) db.close();
    if (dbPath) cleanup(dbPath);
  });

  it('returns a working database instance', () => {
    assert.ok(db);
    db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO test (id) VALUES (1)').run();
    const row = db.prepare('SELECT id FROM test').get();
    assert.equal(row.id, 1);
  });

  it('enables WAL journal mode', () => {
    const mode = db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');
  });

  it('sets synchronous to NORMAL', () => {
    const sync = db.pragma('synchronous', { simple: true });
    // NORMAL = 1
    assert.equal(sync, 1);
  });
});

describe('addColumn', () => {
  let colDb, colDbPath;

  before(() => {
    colDbPath = tmpDbPath();
    colDb = createDatabase(Database, colDbPath);
    colDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
  });

  after(() => {
    if (colDb) colDb.close();
    if (colDbPath) cleanup(colDbPath);
  });

  it('adds a new column to an existing table', () => {
    addColumn(colDb, 'items', "name TEXT DEFAULT ''");

    // Verify column exists by inserting and querying
    colDb.prepare("INSERT INTO items (id, name) VALUES (1, 'test')").run();
    const row = colDb.prepare('SELECT name FROM items WHERE id = 1').get();
    assert.equal(row.name, 'test');
  });

  it('silently ignores duplicate column additions', () => {
    assert.doesNotThrow(() => addColumn(colDb, 'items', "name TEXT DEFAULT ''"));
  });

  it('rethrows non-duplicate-column errors', () => {
    assert.throws(() => {
      addColumn(colDb, 'nonexistent_table', 'col TEXT');
    });
  });
});

import { assertIdentifier } from '../../shared/server/db-setup.mjs';

describe('assertIdentifier', () => {
  it('accepts valid SQL identifiers', () => {
    assert.equal(assertIdentifier('logs'), 'logs');
    assert.equal(assertIdentifier('entry_2026'), 'entry_2026');
    assert.equal(assertIdentifier('_tmp'), '_tmp');
  });

  it('rejects injection-shaped identifiers', () => {
    assert.throws(() => assertIdentifier('logs; DROP TABLE users'));
    assert.throws(() => assertIdentifier('a b'));
    assert.throws(() => assertIdentifier('1abc'));
    assert.throws(() => assertIdentifier(''));
    assert.throws(() => assertIdentifier(null));
  });
});

describe('parseLegacyTimestamp', () => {
  it('retains fractional seconds when converting a legacy KST timestamp to UTC', () => {
    assert.equal(
      parseLegacyTimestamp('2026-09-24T09:00:00.123', { naiveOffset: '+09:00' }),
      '2026-09-24T00:00:00.123Z',
    );
  });
});

describe('rebuildTable', () => {
  let path_, target;

  const open = () => {
    path_ = tmpDbPath();
    target = new Database(path_);
    return target;
  };

  after(() => {
    if (target) target.close();
    if (path_) cleanup(path_);
  });

  it('replaces a stale column default while keeping every row', () => {
    const db = open();
    db.exec(`CREATE TABLE note (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare('INSERT INTO note (body, created_at) VALUES (?, ?)').run('keep me', '2026-01-01');

    rebuildTable(db, 'note', `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);

    const rows = db.prepare('SELECT id, body, created_at FROM note').all();
    assert.deepEqual(rows, [{ id: 1, body: 'keep me', created_at: '2026-01-01' }]);
    const created = db.prepare('PRAGMA table_info(note)').all().find((c) => c.name === 'created_at');
    assert.match(created.dflt_value, /%fZ/);
    db.close();
    cleanup(path_);
  });

  it('moves an appended column back into its declared position', () => {
    const db = open();
    db.exec('CREATE TABLE point (id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL NOT NULL, side TEXT)');
    db.exec('ALTER TABLE point ADD COLUMN alt REAL');
    db.prepare('INSERT INTO point (lat, side, alt) VALUES (?, ?, ?)').run(35.5, 'left', 12.5);

    rebuildTable(db, 'point', `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lat REAL NOT NULL,
      alt REAL,
      side TEXT
    )`);

    assert.deepEqual(
      db.prepare('PRAGMA table_info(point)').all().map((c) => c.name),
      ['id', 'lat', 'alt', 'side'],
    );
    assert.deepEqual(
      db.prepare('SELECT lat, alt, side FROM point').get(),
      { lat: 35.5, alt: 12.5, side: 'left' },
    );
    db.close();
    cleanup(path_);
  });

  it('keeps child rows that a cascading delete would have removed', () => {
    const db = open();
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE
      )`);
    const parentId = db.prepare('INSERT INTO parent (name) VALUES (?)').run('kept').lastInsertRowid;
    db.prepare('INSERT INTO child (parent_id) VALUES (?)').run(parentId);

    rebuildTable(db, 'parent', `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM child').get().count, 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    // 재구축이 끝나면 외래키는 원래 상태로 돌아와야 한다.
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.close();
    cleanup(path_);
  });

  it('leaves a table whose definition already matches untouched', () => {
    const db = open();
    const body = `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL
    )`;
    db.exec(`CREATE TABLE note ${body}`);
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'note'").get().sql;

    rebuildTable(db, 'note', body);

    const after = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'note'").get().sql;
    assert.equal(after, before);
    db.close();
    cleanup(path_);
  });

  it('restores the autoincrement counter as an integer', () => {
    const db = open();
    db.exec('CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)');
    for (const body of ['a', 'b', 'c']) db.prepare('INSERT INTO note (body) VALUES (?)').run(body);
    db.exec('DELETE FROM note');

    rebuildTable(db, 'note', `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT,
      created_at TEXT
    )`);

    const seq = db.prepare("SELECT seq, typeof(seq) AS type FROM sqlite_sequence WHERE name = 'note'").get();
    assert.deepEqual(seq, { seq: 3, type: 'integer' });
    db.close();
    cleanup(path_);
  });

  it('refuses to run inside a transaction, where PRAGMA foreign_keys is ignored', () => {
    const db = open();
    db.exec('CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)');
    assert.throws(
      () => db.transaction(() => rebuildTable(db, 'note', '(id INTEGER PRIMARY KEY AUTOINCREMENT)'))(),
      /트랜잭션 밖에서/,
    );
    db.close();
    cleanup(path_);
  });
});
