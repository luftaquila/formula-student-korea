import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDbPath, cleanup } from '../helpers/test-utils.mjs';

const require = createRequire(import.meta.url);
const Database = require('../../auth/node_modules/better-sqlite3');
import { createDatabase, addColumn } from '../../shared/db-setup.mjs';

let dbPath, db;

describe('createDatabase', () => {
  after(() => {
    if (db) db.close();
    if (dbPath) cleanup(dbPath);
  });

  it('returns a working database instance', () => {
    dbPath = tmpDbPath();
    db = createDatabase(Database, dbPath);
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

  after(() => {
    if (colDb) colDb.close();
    if (colDbPath) cleanup(colDbPath);
  });

  it('adds a new column to an existing table', () => {
    colDbPath = tmpDbPath();
    colDb = createDatabase(Database, colDbPath);
    colDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');

    addColumn(colDb, 'items', "name TEXT DEFAULT ''");

    // Verify column exists by inserting and querying
    colDb.prepare("INSERT INTO items (id, name) VALUES (1, 'test')").run();
    const row = colDb.prepare('SELECT name FROM items WHERE id = 1').get();
    assert.equal(row.name, 'test');
  });

  it('silently ignores duplicate column additions', () => {
    // Should not throw
    addColumn(colDb, 'items', "name TEXT DEFAULT ''");
  });

  it('rethrows non-duplicate-column errors', () => {
    assert.throws(() => {
      addColumn(colDb, 'nonexistent_table', 'col TEXT');
    });
  });
});
