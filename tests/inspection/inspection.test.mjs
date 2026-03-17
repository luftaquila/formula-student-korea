import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  tmpDbPath,
  makeAuthCookie,
  createClient,
  startServer,
  stopServer,
  cleanup,
  setupTestEnv,
  TEST_SECRET,
  TEST_INTERNAL_SECRET,
} from '../helpers/test-utils.mjs';

setupTestEnv();

import { createInspectionApp } from '../../inspection/index.mjs';

const CURRENT_YEAR = new Date().getFullYear();
const PREV_YEAR = CURRENT_YEAR - 1;

const adminCookie = makeAuthCookie({ email: 'admin@test.com', name: 'Admin', role: 'admin' });
const officialCookie = makeAuthCookie({ email: 'official@test.com', name: 'Official', role: 'official' });

let server, baseUrl, client, db, dbPath;

before(async () => {
  dbPath = tmpDbPath();
  const result = createInspectionApp({ dbPath });
  db = result.db;
  const started = await startServer(result.app);
  server = started.server;
  baseUrl = started.baseUrl;
  client = createClient(baseUrl);
});

after(async () => {
  await stopServer(server);
  db.close();
  cleanup(dbPath);
});

// ─── Health ─────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('returns 200 "ok"', async () => {
    const res = await client.get('/api/health');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  });
});

// ─── Template CRUD ──────────────────────────────────────────────────────
describe('Template CRUD', () => {
  let categoryId, subcategoryId, groupId, itemId;

  it('GET /api/sheet/template?year=CURRENT_YEAR returns empty array initially', async () => {
    const res = await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 0);
  });

  it('POST /api/sheet/template creates category (requires admin)', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'Mechanical' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    categoryId = Number(data.id);
  });

  it('POST /api/sheet/template creates subcategory with parent_id', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: categoryId, name: 'Brakes' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    subcategoryId = Number(data.id);
  });

  it('POST /api/sheet/template creates group under subcategory', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subcategoryId, name: 'Brake Lines' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    groupId = Number(data.id);
  });

  it('POST /api/sheet/template creates item under group with answer_type', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: groupId, name: 'Brake fluid level', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.id);
    itemId = Number(data.id);
  });

  it('POST /api/sheet/template rejects missing required fields (400)', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('GET /api/sheet/template?year=CURRENT_YEAR returns tree structure', async () => {
    const res = await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const tree = await res.json();
    assert.ok(Array.isArray(tree));
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'Mechanical');
    assert.equal(tree[0].level, 'category');
    assert.ok(Array.isArray(tree[0].subcategories));
    assert.equal(tree[0].subcategories.length, 1);
    assert.equal(tree[0].subcategories[0].name, 'Brakes');
    assert.ok(Array.isArray(tree[0].subcategories[0].groups));
    assert.equal(tree[0].subcategories[0].groups.length, 1);
    assert.equal(tree[0].subcategories[0].groups[0].name, 'Brake Lines');
    assert.ok(Array.isArray(tree[0].subcategories[0].groups[0].items));
    assert.equal(tree[0].subcategories[0].groups[0].items.length, 1);
    assert.equal(tree[0].subcategories[0].groups[0].items[0].name, 'Brake fluid level');
  });

  it('GET /api/sheet/template rejects missing year (400)', async () => {
    const res = await client.get('/api/sheet/template', { cookie: officialCookie });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/template/:id updates name', async () => {
    const res = await client.put(`/api/sheet/template/${categoryId}`, {
      body: { name: 'Mechanical Inspection' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    // Verify
    const getRes = await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    const tree = await getRes.json();
    assert.equal(tree[0].name, 'Mechanical Inspection');
  });

  it('PUT /api/sheet/template/:id updates sort_order', async () => {
    const res = await client.put(`/api/sheet/template/${categoryId}`, {
      body: { sort_order: 5 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/template/:id updates answer_type', async () => {
    const res = await client.put(`/api/sheet/template/${itemId}`, {
      body: { answer_type: 'number' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/template/:id updates remarks', async () => {
    const res = await client.put(`/api/sheet/template/${itemId}`, {
      body: { remarks: 'Check carefully' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/template/:id updates unit', async () => {
    const res = await client.put(`/api/sheet/template/${itemId}`, {
      body: { unit: 'mm' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/template/:id updates pdf_include', async () => {
    const res = await client.put(`/api/sheet/template/${itemId}`, {
      body: { pdf_include: 0 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/template/:id rejects no fields (400)', async () => {
    const res = await client.put(`/api/sheet/template/${categoryId}`, {
      body: {},
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/template/:id returns 404 for non-existent', async () => {
    const res = await client.put('/api/sheet/template/99999', {
      body: { name: 'Ghost' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 404);
  });

  it('DELETE /api/sheet/template/:id deletes node (CASCADE)', async () => {
    // Create a throwaway category + subcategory, then delete the category
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'TempCat' },
      cookie: adminCookie,
    });
    const catData = await catRes.json();
    const tempCatId = Number(catData.id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: tempCatId, name: 'TempSub' },
      cookie: adminCookie,
    });
    const subData = await subRes.json();
    const tempSubId = Number(subData.id);

    // Delete parent → child should cascade
    const delRes = await client.delete(`/api/sheet/template/${tempCatId}`, { cookie: adminCookie });
    assert.equal(delRes.status, 200);

    // Verify child is gone too
    const tree = await (await client.get(`/api/sheet/template?year=${CURRENT_YEAR}`, { cookie: officialCookie })).json();
    const ids = [];
    for (const cat of tree) {
      ids.push(cat.id);
      for (const sub of cat.subcategories || []) ids.push(sub.id);
    }
    assert.ok(!ids.includes(tempCatId));
    assert.ok(!ids.includes(tempSubId));
  });

  it('DELETE /api/sheet/template/:id blocks previous year deletion', async () => {
    // Insert a previous-year node directly into the DB
    const info = db.prepare(
      "INSERT INTO sheet_template (year, level, name, sort_order) VALUES (?, 'category', 'OldCat', 0)"
    ).run(PREV_YEAR);
    const oldId = Number(info.lastInsertRowid);

    const res = await client.delete(`/api/sheet/template/${oldId}`, { cookie: adminCookie });
    assert.equal(res.status, 400);

    // Clean up
    db.prepare("DELETE FROM sheet_template WHERE id = ?").run(oldId);
  });

  it('DELETE /api/sheet/template/:id returns 404 for non-existent', async () => {
    const res = await client.delete('/api/sheet/template/99999', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

// ─── Reorder ────────────────────────────────────────────────────────────
describe('Template Reorder', () => {
  it('POST /api/sheet/template/reorder reorders items', async () => {
    // Create two categories to reorder
    const r1 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'ReorderA', sort_order: 0 },
      cookie: adminCookie,
    });
    const r2 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'ReorderB', sort_order: 1 },
      cookie: adminCookie,
    });
    const id1 = Number((await r1.json()).id);
    const id2 = Number((await r2.json()).id);

    const res = await client.post('/api/sheet/template/reorder', {
      body: { items: [{ id: id1, sort_order: 1 }, { id: id2, sort_order: 0 }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 200);

    // Clean up
    await client.delete(`/api/sheet/template/${id1}`, { cookie: adminCookie });
    await client.delete(`/api/sheet/template/${id2}`, { cookie: adminCookie });
  });

  it('POST /api/sheet/template/reorder rejects non-array (400)', async () => {
    const res = await client.post('/api/sheet/template/reorder', {
      body: { items: 'not-array' },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/sheet/template/reorder rejects invalid items (400)', async () => {
    const res = await client.post('/api/sheet/template/reorder', {
      body: { items: [{ id: 'abc', sort_order: 'xyz' }] },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/sheet/template/reorder rejects >1000 items', async () => {
    const items = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, sort_order: i }));
    const res = await client.post('/api/sheet/template/reorder', {
      body: { items },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Copy ───────────────────────────────────────────────────────────────
describe('Template Copy', () => {
  const SOURCE_YEAR = CURRENT_YEAR + 100;
  const TARGET_YEAR = CURRENT_YEAR + 101;

  before(async () => {
    // Seed source year with a category
    await client.post('/api/sheet/template', {
      body: { year: SOURCE_YEAR, level: 'category', name: 'CopyCat' },
      cookie: adminCookie,
    });
  });

  after(async () => {
    // Clean up both years
    db.prepare("DELETE FROM sheet_template WHERE year IN (?, ?)").run(SOURCE_YEAR, TARGET_YEAR);
  });

  it('POST /api/sheet/template/copy copies template between years', async () => {
    const res = await client.post('/api/sheet/template/copy', {
      body: { from_year: SOURCE_YEAR, to_year: TARGET_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);

    // Verify target has data
    const tree = await (await client.get(`/api/sheet/template?year=${TARGET_YEAR}`, { cookie: officialCookie })).json();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'CopyCat');
  });

  it('POST /api/sheet/template/copy rejects if target year already has data (400)', async () => {
    const res = await client.post('/api/sheet/template/copy', {
      body: { from_year: SOURCE_YEAR, to_year: TARGET_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/sheet/template/copy rejects if source year is empty (400)', async () => {
    const EMPTY_YEAR = CURRENT_YEAR + 200;
    const res = await client.post('/api/sheet/template/copy', {
      body: { from_year: EMPTY_YEAR, to_year: CURRENT_YEAR + 201 },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Import ─────────────────────────────────────────────────────────────
describe('Template Import', () => {
  const IMPORT_YEAR = CURRENT_YEAR + 300;

  after(async () => {
    db.prepare("DELETE FROM sheet_template WHERE year = ?").run(IMPORT_YEAR);
  });

  it('POST /api/sheet/template/import imports template from JSON', async () => {
    const template = [
      {
        name: 'ImportedCat',
        subcategories: [
          {
            name: 'ImportedSub',
            groups: [
              {
                name: 'ImportedGroup',
                items: [
                  { name: 'ImportedItem', answer_type: 'passfail' },
                ],
              },
            ],
          },
        ],
      },
    ];
    const res = await client.post('/api/sheet/template/import', {
      body: { year: IMPORT_YEAR, template },
      cookie: adminCookie,
    });
    assert.equal(res.status, 201);

    // Verify imported structure
    const tree = await (await client.get(`/api/sheet/template?year=${IMPORT_YEAR}`, { cookie: officialCookie })).json();
    assert.equal(tree.length, 1);
    assert.equal(tree[0].name, 'ImportedCat');
    assert.equal(tree[0].subcategories[0].name, 'ImportedSub');
    assert.equal(tree[0].subcategories[0].groups[0].name, 'ImportedGroup');
    assert.equal(tree[0].subcategories[0].groups[0].items[0].name, 'ImportedItem');
  });

  it('POST /api/sheet/template/import rejects missing fields (400)', async () => {
    const res = await client.post('/api/sheet/template/import', {
      body: { year: IMPORT_YEAR },
      cookie: adminCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Answer CRUD ────────────────────────────────────────────────────────
describe('Answer CRUD', () => {
  let answerItemId, answerCategoryId;

  before(async () => {
    // Create a full template tree for answer tests
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'AnswerCat' },
      cookie: adminCookie,
    });
    answerCategoryId = Number((await catRes.json()).id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: answerCategoryId, name: 'AnswerSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);

    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'AnswerGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);

    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'AnswerItem', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    answerItemId = Number((await itemRes.json()).id);
  });

  it('PUT /api/sheet/answer upserts answer (requires official)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/answer validates passfail type (only PASS/FAIL/"")', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: answerItemId, value: 'INVALID' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer rejects missing fields (400)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer rejects previous year (400)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: PREV_YEAR, team_num: 1, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer rejects non-existent item (400)', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: 99999, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/answer does not broadcast when value unchanged', async () => {
    // Set value to PASS first
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 99, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });

    // Set same value again - should return 200 but not broadcast
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 99, item_id: answerItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
    // We can't directly verify no broadcast without SSE client,
    // but we can verify the endpoint handles duplicate gracefully
  });
});

// ─── Memo ───────────────────────────────────────────────────────────────
describe('Memo', () => {
  let memoItemId;

  before(async () => {
    // Create a template item for memo tests
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'MemoCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'MemoSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);

    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'MemoGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);

    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'MemoItem', answer_type: 'text' },
      cookie: adminCookie,
    });
    memoItemId = Number((await itemRes.json()).id);
  });

  it('PUT /api/sheet/memo upserts memo', async () => {
    const res = await client.put('/api/sheet/memo', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: memoItemId, memo: 'Test memo text' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/memo rejects missing fields (400)', async () => {
    const res = await client.put('/api/sheet/memo', {
      body: { year: CURRENT_YEAR },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/memo rejects previous year (400)', async () => {
    const res = await client.put('/api/sheet/memo', {
      body: { year: PREV_YEAR, team_num: 1, item_id: memoItemId, memo: 'Old memo' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Category Result ────────────────────────────────────────────────────
describe('Category Result', () => {
  let resultCategoryId, resultNonCategoryId;

  before(async () => {
    // Create a category for result tests
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'ResultCat' },
      cookie: adminCookie,
    });
    resultCategoryId = Number((await catRes.json()).id);

    // Create a subcategory (non-category) for negative test
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: resultCategoryId, name: 'ResultSub' },
      cookie: adminCookie,
    });
    resultNonCategoryId = Number((await subRes.json()).id);
  });

  it('PUT /api/sheet/category-result upserts result', async () => {
    const res = await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: resultCategoryId, result: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/category-result validates result values (PASS/FAIL/"")', async () => {
    const res = await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: resultCategoryId, result: 'INVALID' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });

  it('PUT /api/sheet/category-result rejects non-category (400)', async () => {
    const res = await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: resultNonCategoryId, result: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);
  });
});

// ─── Inspector ──────────────────────────────────────────────────────────
describe('Inspector', () => {
  let inspectorCategoryId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'InspectorCat' },
      cookie: adminCookie,
    });
    inspectorCategoryId = Number((await catRes.json()).id);
  });

  it('PUT /api/sheet/inspector upserts inspector', async () => {
    const res = await client.put('/api/sheet/inspector', {
      body: { year: CURRENT_YEAR, team_num: 1, category_id: inspectorCategoryId, inspector: 'John' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('PUT /api/sheet/inspector rejects previous year (400)', async () => {
    // Insert a previous-year category directly for this test
    const info = db.prepare(
      "INSERT INTO sheet_template (year, level, name, sort_order) VALUES (?, 'category', 'OldInspCat', 0)"
    ).run(PREV_YEAR);
    const oldCatId = Number(info.lastInsertRowid);

    const res = await client.put('/api/sheet/inspector', {
      body: { year: PREV_YEAR, team_num: 1, category_id: oldCatId, inspector: 'Old' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 400);

    // Clean up
    db.prepare("DELETE FROM sheet_template WHERE id = ?").run(oldCatId);
  });
});

// ─── Data Queries ───────────────────────────────────────────────────────
describe('Data Queries', () => {
  let dataCategoryId, dataItemId;

  before(async () => {
    // Create a complete template tree and populate data
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'DataCat' },
      cookie: adminCookie,
    });
    dataCategoryId = Number((await catRes.json()).id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: dataCategoryId, name: 'DataSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);

    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'DataGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);

    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'DataItem', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    dataItemId = Number((await itemRes.json()).id);

    // Populate answer, category-result, inspector
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 10, item_id: dataItemId, value: 'PASS' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/category-result', {
      body: { year: CURRENT_YEAR, team_num: 10, category_id: dataCategoryId, result: 'PASS' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/inspector', {
      body: { year: CURRENT_YEAR, team_num: 10, category_id: dataCategoryId, inspector: 'DataInspector' },
      cookie: officialCookie,
    });
  });

  it('GET /api/sheet/data/:year/:num returns answers, results, inspectors', async () => {
    const res = await client.get(`/api/sheet/data/${CURRENT_YEAR}/10`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.answers);
    assert.ok(data.results);
    assert.ok(data.inspectors);
    assert.equal(data.answers[dataItemId].value, 'PASS');
    assert.equal(data.results[dataCategoryId], 'PASS');
    assert.equal(data.inspectors[dataCategoryId], 'DataInspector');
  });

  it('GET /api/sheet/summary returns team summaries', async () => {
    const res = await client.get(`/api/sheet/summary?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.categories);
    assert.ok(Array.isArray(data.categories));
    assert.ok(data.teams);
    assert.ok(data.teams[10]);
    assert.equal(data.teams[10].results[dataCategoryId], 'PASS');
    assert.equal(data.teams[10].inspectors[dataCategoryId], 'DataInspector');
  });

  it('GET /api/sheet/bulk-answers returns bulk answers for item_ids', async () => {
    const res = await client.get(`/api/sheet/bulk-answers?year=${CURRENT_YEAR}&item_ids=${dataItemId}`, { cookie: officialCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data[10]);
    assert.equal(data[10][dataItemId], 'PASS');
  });
});

// ─── Number/Text answer_type ─────────────────────────────────────────────
describe('Number and Text answer types', () => {
  let numberItemId, textItemId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'TypeTestCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'TypeTestSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'TypeTestGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const numRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'NumItem', answer_type: 'number' },
      cookie: adminCookie,
    });
    numberItemId = Number((await numRes.json()).id);
    const txtRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'TxtItem', answer_type: 'text' },
      cookie: adminCookie,
    });
    textItemId = Number((await txtRes.json()).id);
  });

  it('accepts numeric value for number answer_type', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: numberItemId, value: '42.5' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('accepts empty value for number answer_type', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: numberItemId, value: '' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('accepts text value for text answer_type', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: textItemId, value: 'Some text answer' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('verifies stored values via data endpoint', async () => {
    // Set a number value first
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: numberItemId, value: '99' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: textItemId, value: 'Final text' },
      cookie: officialCookie,
    });

    const res = await client.get(`/api/sheet/data/${CURRENT_YEAR}/1`, { cookie: officialCookie });
    const data = await res.json();
    assert.equal(data.answers[numberItemId].value, '99');
    assert.equal(data.answers[textItemId].value, 'Final text');
  });
});

// ─── Bulk answers filtering ──────────────────────────────────────────────
describe('Bulk answers filtering', () => {
  let filterItem1, filterItem2, filterItem3;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'FilterCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'FilterSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'FilterGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const i1 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'F1', answer_type: 'text' },
      cookie: adminCookie,
    });
    filterItem1 = Number((await i1.json()).id);
    const i2 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'F2', answer_type: 'text' },
      cookie: adminCookie,
    });
    filterItem2 = Number((await i2.json()).id);
    const i3 = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'F3', answer_type: 'text' },
      cookie: adminCookie,
    });
    filterItem3 = Number((await i3.json()).id);

    // Set answers for team 20
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 20, item_id: filterItem1, value: 'val1' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 20, item_id: filterItem2, value: 'val2' },
      cookie: officialCookie,
    });
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 20, item_id: filterItem3, value: 'val3' },
      cookie: officialCookie,
    });
  });

  it('returns only requested item_ids', async () => {
    const res = await client.get(
      `/api/sheet/bulk-answers?year=${CURRENT_YEAR}&item_ids=${filterItem1},${filterItem3}`,
      { cookie: officialCookie },
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data[20]);
    assert.equal(data[20][filterItem1], 'val1');
    assert.equal(data[20][filterItem3], 'val3');
    assert.equal(data[20][filterItem2], undefined, 'should not include unrequested item');
  });

  it('rejects missing item_ids parameter', async () => {
    const res = await client.get(`/api/sheet/bulk-answers?year=${CURRENT_YEAR}`, { cookie: officialCookie });
    assert.equal(res.status, 400);
  });

  it('rejects missing year parameter', async () => {
    const res = await client.get(`/api/sheet/bulk-answers?item_ids=${filterItem1}`, { cookie: officialCookie });
    assert.equal(res.status, 400);
  });
});

// ─── SSE broadcast verification ──────────────────────────────────────────
describe('SSE broadcast on data changes', () => {
  let sseItemId;

  before(async () => {
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'SSECat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);
    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'SSESub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);
    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'SSEGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);
    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'SSEItem', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    sseItemId = Number((await itemRes.json()).id);
  });

  it('SSE endpoint returns event stream with init event', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/sheet/events`, {
      headers: { Cookie: officialCookie },
      signal: controller.signal,
    }).catch(() => null);

    if (res) {
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      // Read a small chunk to verify init event
      const reader = res.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      assert.ok(text.includes('event: init'), 'should receive init event');
      controller.abort();
      reader.releaseLock();
    }
  });

  it('answer update triggers SSE broadcast', async () => {
    // Connect SSE client
    const controller = new AbortController();
    const sseRes = await fetch(`${baseUrl}/api/sheet/events`, {
      headers: { Cookie: officialCookie },
      signal: controller.signal,
    });
    const reader = sseRes.body.getReader();

    // Read past init event
    await reader.read();

    // Trigger answer update
    await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 50, item_id: sseItemId, value: 'PASS' },
      cookie: officialCookie,
    });

    // Read broadcast event (with timeout)
    const readWithTimeout = () => Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
    ]);

    try {
      const { value } = await readWithTimeout();
      const text = new TextDecoder().decode(value);
      assert.ok(text.includes('event: answer'), 'should receive answer broadcast event');
      assert.ok(text.includes('"team_num":50'), 'broadcast should include team_num');
    } finally {
      controller.abort();
      reader.releaseLock();
    }
  });
});

// ─── Auth Enforcement ───────────────────────────────────────────────────
describe('Auth enforcement', () => {
  it('POST /api/sheet/template without auth returns 401', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'NoAuth' },
    });
    assert.equal(res.status, 401);
  });

  it('PUT /api/sheet/answer without auth returns 401', async () => {
    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: 1, value: 'PASS' },
    });
    assert.equal(res.status, 401);
  });

  it('PUT /api/sheet/answer with official cookie returns 200 (official access)', async () => {
    // Need a valid item_id; create one with admin first
    const catRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'AuthTestCat' },
      cookie: adminCookie,
    });
    const catId = Number((await catRes.json()).id);

    const subRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'subcategory', parent_id: catId, name: 'AuthTestSub' },
      cookie: adminCookie,
    });
    const subId = Number((await subRes.json()).id);

    const grpRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'group', parent_id: subId, name: 'AuthTestGrp' },
      cookie: adminCookie,
    });
    const grpId = Number((await grpRes.json()).id);

    const itemRes = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'item', parent_id: grpId, name: 'AuthTestItem', answer_type: 'passfail' },
      cookie: adminCookie,
    });
    const itemId = Number((await itemRes.json()).id);

    const res = await client.put('/api/sheet/answer', {
      body: { year: CURRENT_YEAR, team_num: 1, item_id: itemId, value: 'PASS' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 200);
  });

  it('POST /api/sheet/template with official cookie returns 403 (admin required)', async () => {
    const res = await client.post('/api/sheet/template', {
      body: { year: CURRENT_YEAR, level: 'category', name: 'OfficialTry' },
      cookie: officialCookie,
    });
    assert.equal(res.status, 403);
  });
});
