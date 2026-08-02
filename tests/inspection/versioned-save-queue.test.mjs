import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVersionedSaveQueue } from '../../inspection/web/src/utils/versioned-save-queue.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('Versioned save queue', () => {
  it('serializes one item and coalesces queued values to the latest value', async () => {
    const calls = [];
    const resolvers = [];
    const saved = [];
    const queue = createVersionedSaveQueue({
      getVersion: () => 0,
      makeMutationId: (() => {
        let id = 0;
        return () => `mutation-${++id}`;
      })(),
      save: (itemId, request) => new Promise(resolve => {
        calls.push({ itemId, ...request });
        resolvers.push(response => resolve(response));
      }),
      onSaved: (itemId, response, value) => saved.push({ itemId, response, value }),
    });

    const completed = queue.enqueue(1, 'PASS', { immediate: true });
    queue.enqueue(1, '', { immediate: true });
    queue.enqueue(1, 'FAIL', { immediate: true });

    assert.deepEqual(calls.map(call => call.value), ['PASS']);
    resolvers.shift()({ value: 'PASS', version: 1 });
    await tick();

    assert.deepEqual(calls.map(call => call.value), ['PASS', 'FAIL']);
    assert.equal(calls[1].baseVersion, 1);
    resolvers.shift()({ value: 'FAIL', version: 2 });
    await completed;

    assert.deepEqual(saved.map(item => item.value), ['PASS', 'FAIL']);
    assert.equal(queue.currentVersion(1), 2);
    assert.equal(queue.isDirty(1), false);
  });

  it('keeps a conflicting local value and retries from the server version', async () => {
    const calls = [];
    const conflicts = [];
    let attempt = 0;
    const queue = createVersionedSaveQueue({
      getVersion: () => 2,
      makeMutationId: () => `mutation-${attempt + 1}`,
      save: async (itemId, request) => {
        calls.push({ itemId, ...request });
        attempt += 1;
        if (attempt === 1) {
          const error = new Error('conflict');
          error.status = 409;
          error.data = { current: { value: 'server', version: 3 } };
          throw error;
        }
        return { value: request.value, version: 4 };
      },
      onConflict: (itemId, current, localValue) => conflicts.push({ itemId, current, localValue }),
    });

    await queue.enqueue(9, 'local', { immediate: true });
    assert.equal(queue.isDirty(9), true);
    assert.equal(conflicts[0].current.value, 'server');
    assert.equal(conflicts[0].localValue, 'local');

    await queue.retry(9);
    assert.equal(calls[1].baseVersion, 3);
    assert.equal(calls[1].value, 'local');
    assert.equal(queue.currentVersion(9), 4);
    assert.equal(queue.isDirty(9), false);
  });

  it('ignores a request completion after the user accepts the server value', async () => {
    const calls = [];
    const saved = [];
    let resolveSave;
    const queue = createVersionedSaveQueue({
      getVersion: () => 0,
      makeMutationId: () => 'mutation-1',
      save: (itemId, request) => new Promise(resolve => {
        calls.push({ itemId, ...request });
        resolveSave = resolve;
      }),
      onSaved: (itemId, response, value) => saved.push({ itemId, response, value }),
    });

    const completed = queue.enqueue(3, 'local', { immediate: true });
    queue.markConflict(3, { value: 'server', version: 2 });
    queue.resolveWithRemote(3, 2);
    resolveSave({ value: 'local', version: 1 });
    await completed;

    assert.equal(calls.length, 1);
    assert.deepEqual(saved, []);
    assert.equal(queue.currentVersion(3), 2);
    assert.equal(queue.isDirty(3), false);
  });

  it('keeps the newest SSE conflict when an older 409 arrives later', async () => {
    const calls = [];
    const conflicts = [];
    let rejectSave;
    let attempt = 0;
    const queue = createVersionedSaveQueue({
      getVersion: () => 0,
      makeMutationId: () => `mutation-${attempt + 1}`,
      save: (itemId, request) => {
        calls.push({ itemId, ...request });
        attempt += 1;
        if (attempt === 1) {
          return new Promise((_, reject) => { rejectSave = reject; });
        }
        return Promise.resolve({ value: request.value, version: 3 });
      },
      onConflict: (itemId, current, localValue) => conflicts.push({ itemId, current, localValue }),
    });

    const completed = queue.enqueue(4, 'local', { immediate: true });
    queue.markConflict(4, { value: 'newer-server', version: 2 });
    const stale = new Error('stale conflict');
    stale.status = 409;
    stale.data = { current: { value: 'older-server', version: 1 } };
    rejectSave(stale);
    await completed;

    assert.equal(queue.currentVersion(4), 2);
    assert.equal(conflicts.at(-1).current.value, 'newer-server');
    assert.equal(conflicts.at(-1).current.version, 2);

    await queue.retry(4);
    assert.equal(calls[1].baseVersion, 2);
    assert.equal(queue.currentVersion(4), 3);
    assert.equal(queue.isDirty(4), false);
  });
});
