import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import test from 'node:test';
import { createClient } from '../src/falkordb-client.js';
import { encodeCommand, RespParser } from '../src/resp.js';
import { createFalkorDBStore } from '../src/store/falkordb-store.js';

// GRAPH.DELETE is deliberately outside the public client/store contract.
async function deleteGraph(url, graph) {
  const address = new URL(url);
  const host = address.hostname.replace(/^\[|\]$/g, '');
  const secure = address.protocol === 'rediss:';
  const options = { host, port: Number(address.port || 6379) };
  if (secure && !net.isIP(host)) options.servername = host;
  const commands = [];
  const user = decodeURIComponent(address.username);
  const password = decodeURIComponent(address.password);
  if (user || password) commands.push(user ? ['AUTH', user, password] : ['AUTH', password]);
  const database = Number(address.pathname.slice(1) || 0);
  if (database) commands.push(['SELECT', database]);
  commands.push(['GRAPH.DELETE', graph]);
  await new Promise((resolve, reject) => {
    const socket = secure ? tls.connect(options) : net.createConnection(options);
    const parser = new RespParser();
    const timer = setTimeout(() => finish(new Error('GRAPH.DELETE timed out')), 10_000);
    let done = false;
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    socket.on('error', finish);
    socket.on('close', () => { if (!done) finish(new Error('Connection closed during GRAPH.DELETE')); });
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(encodeCommand(commands.shift())));
    socket.on('data', (chunk) => {
      try {
        for (const reply of parser.push(chunk)) {
          if (reply instanceof Error) return finish(reply);
          if (commands.length) {
            assert.equal(reply, 'OK');
            socket.write(encodeCommand(commands.shift()));
          } else {
            assert.equal(typeof reply, 'string');
            assert.match(reply, /Graph removed/i);
            finish();
          }
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

test('FalkorDB store satisfies the complete contract against a real server', async (t) => {
  const url = process.env.FALKORDB_URL;
  if (!url) {
    t.skip('FALKORDB_URL is not set; real FalkorDB integration is opt-in');
    return;
  }
  const user = `integration_${randomUUID()}`;
  const otherUser = `${user}_other`;
  const graphs = new Set();
  const store = createFalkorDBStore({ url });
  const inspector = createClient({ url });
  t.after(async () => {
    try {
      const deleted = await Promise.allSettled([...graphs].map((graph) => deleteGraph(url, graph)));
      const failures = deleted.filter((entry) => entry.status === 'rejected').map((entry) => entry.reason);
      if (failures.length) throw new AggregateError(failures, 'Failed to remove integration graphs');
    } finally {
      await Promise.all([store.close(), inspector.close()]);
    }
  });
  for (const owner of [user, otherUser]) {
    const graph = `memory:${owner}`;
    await inspector.query(graph, 'RETURN 1');
    graphs.add(graph);
    await store.ensureIndexes({ user: owner, dim: 3 });
  }

  const createdAt = '2026-10-01T00:00:00.000Z';
  const later = '2026-10-02T00:00:00.000Z';
  const newest = '2026-10-03T00:00:00.000Z';
  const hostile = '"quote" \'single\'\n日本語 $id \\path "; MATCH (n) DELETE n //';

  await t.test('ensureIndexes creates operational cosine and id indexes and is repeatable', async () => {
    await store.ensureIndexes({ user, dim: 3 });
    const { rows } = await inspector.query(`memory:${user}`,
      'CALL db.indexes() YIELD label, types, options, entitytype, status RETURN label, types, options, entitytype, status');
    const vector = rows.find(([label, types, , entity]) =>
      label === 'Memory' && entity === 'NODE' && types.embedding?.includes('VECTOR'));
    assert.ok(vector);
    assert.equal(vector[2].embedding.dimension, 3);
    assert.equal(vector[2].embedding.similarityFunction, 'cosine');
    assert.equal(vector[4], 'OPERATIONAL');
    for (const name of ['Memory', 'Topic', 'Source']) {
      assert.ok(rows.some(([label, types, , entity]) => label === name && entity === 'NODE' && types.id?.includes('RANGE')));
    }
    await assert.rejects(store.ensureIndexes({ user, dim: 4 }), /incompatible/);
  });

  await t.test('upsertNode and getNode round-trip properties, multi-labels, embeddings and hostile strings', async () => {
    const props = { title: hostile, text: 'original', createdAt, occurredAt: createdAt, count: 7, active: true, tags: ['a', '日本語'] };
    const inserted = await store.upsertNode({ user, id: hostile, labels: ['Memory', 'Pinned'], props, embedding: [1, 0, 0] });
    assert.equal(inserted.id, hostile);
    assert.deepEqual(new Set(inserted.labels), new Set(['Memory', 'Pinned']));
    assert.deepEqual(inserted.props, props);
    assert.ok(!Object.hasOwn(inserted.props, 'embedding'));
    const updated = await store.upsertNode({ user, id: hostile, labels: ['Memory'], props: { text: 'updated' } });
    assert.deepEqual(updated.props, { ...props, text: 'updated' });
    assert.deepEqual(await store.getNode({ user, id: hostile }), updated);
    assert.equal(await store.getNode({ user, id: 'missing' }), null);
    assert.equal((await store.findNodes({ user, where: { id: hostile } })).length, 1);
    const matches = await store.vectorSearch({ user, embedding: [1, 0, 0], k: 1 });
    assert.equal(matches[0].node.id, hostile);
    assert.ok(Math.abs(matches[0].score - 1) < 1e-5, 'omitting embedding on upsert preserves the vector');
    await store.upsertNode({ user, id: 'topic', labels: ['Topic'], props: { name: 'ハンバーグ', createdAt: later } });
    await store.upsertNode({ user, id: 'source', labels: ['Source'], props: { name: 'claude', createdAt: newest } });
    await store.upsertNode({ user, id: 'unembedded', labels: ['Memory'], props: { createdAt: later } });
    await store.upsertNode({ user, id: 'unlabeled', labels: [], props: { flag: true } });
  });

  await t.test('findNodes and listNodes filter, order, limit and isolate users', async () => {
    assert.deepEqual((await store.findNodes({ user, label: 'Topic', where: { name: 'ハンバーグ' } })).map((n) => n.id), ['topic']);
    assert.deepEqual((await store.findNodes({ user, label: 'Memory', where: { title: hostile, count: 7, active: true } })).map((n) => n.id), [hostile]);
    assert.deepEqual(await store.findNodes({ user, where: { title: 'missing' } }), []);
    assert.deepEqual(await store.findNodes({ user, limit: 0 }), []);
    assert.equal((await store.findNodes({ user, limit: 2 })).length, 2);
    assert.deepEqual((await store.listNodes({ user, sinceIso: later, limit: 2 })).map((n) => n.id), ['source', 'topic']);
    assert.deepEqual((await store.listNodes({ user, label: 'Memory', sinceIso: later })).map((n) => n.id), ['unembedded']);
    assert.deepEqual((await store.listNodes({ user, label: 'Memory' })).map((n) => n.id), ['unembedded', hostile]);
    assert.deepEqual(await store.listNodes({ user, limit: 0 }), []);
    assert.equal(await store.getNode({ user: otherUser, id: hostile }), null);
    assert.deepEqual(await store.findNodes({ user: otherUser }), []);
    assert.deepEqual(await store.listNodes({ user: otherUser }), []);
    await store.upsertNode({ user: otherUser, id: hostile, labels: ['Memory'], props: { title: 'isolated' }, embedding: [0, 1, 0] });
    assert.equal((await store.getNode({ user, id: hostile })).props.title, hostile);
    assert.equal((await store.getNode({ user: otherUser, id: hostile })).props.title, 'isolated');
  });

  await t.test('addEdge upserts one directed relation; neighbors traverse both directions ordered by weight', async () => {
    await store.addEdge({ user, from: hostile, to: 'topic', type: 'ABOUT', props: { w: 0.2, reason: hostile } });
    const relation = await store.addEdge({ user, from: hostile, to: 'topic', type: 'ABOUT', props: { w: 0.9 } });
    assert.deepEqual(relation, { from: hostile, to: 'topic', type: 'ABOUT', props: { w: 0.9, reason: hostile } });
    await store.addEdge({ user, from: 'source', to: hostile, type: 'MENTIONED_BY', props: { w: 0.5 } });
    await store.addEdge({ user, from: hostile, to: 'unembedded', type: 'RELATES_TO' });
    const neighbors = await store.neighbors({ user, id: hostile, limit: 5 });
    assert.deepEqual(neighbors.map(({ node }) => node.id), ['topic', 'source', 'unembedded']);
    assert.deepEqual(neighbors[0].edge, relation);
    assert.deepEqual(neighbors[1].edge, { from: 'source', to: hostile, type: 'MENTIONED_BY', props: { w: 0.5 } });
    assert.deepEqual(neighbors[2].edge.props, {});
    const reverse = await store.neighbors({ user, id: 'topic', limit: 5 });
    assert.equal(reverse.length, 1, 'same (from, to, type) must not create duplicate edges');
    assert.equal(reverse[0].node.id, hostile);
    assert.deepEqual(reverse[0].edge, relation);
    assert.deepEqual((await store.neighbors({ user, id: hostile, types: ['MENTIONED_BY'], limit: 5 })).map(({ node }) => node.id), ['source']);
    assert.equal((await store.neighbors({ user, id: hostile, limit: 1 })).length, 1);
    assert.deepEqual(await store.neighbors({ user, id: hostile, limit: 0 }), []);
    assert.deepEqual(await store.neighbors({ user, id: 'missing', limit: 5 }), []);
    assert.deepEqual(await store.neighbors({ user: otherUser, id: hostile, limit: 5 }), []);
    await assert.rejects(store.addEdge({ user, from: hostile, to: 'missing', type: 'ABOUT' }), /endpoints/);
  });

  await t.test('vectorSearch uses cosine similarity, excludes unembedded nodes and filters before top-k', async () => {
    await store.upsertNode({ user, id: 'orthogonal', labels: ['Memory', 'Filtered'], props: {}, embedding: [0, 1, 0] });
    await store.upsertNode({ user, id: 'opposite', labels: ['Memory', 'Filtered'], props: {}, embedding: [-1, 0, 0] });
    const matches = await store.vectorSearch({ user, embedding: [1, 0, 0], k: 10 });
    assert.deepEqual(matches.map(({ node }) => node.id), [hostile, 'orthogonal', 'opposite']);
    for (const [index, expected] of [1, 0, -1].entries()) {
      assert.ok(Math.abs(matches[index].score - expected) < 1e-5);
      assert.ok(!Object.hasOwn(matches[index].node.props, 'embedding'));
    }
    assert.deepEqual((await store.vectorSearch({ user, embedding: [1, 0, 0], k: 1 })).map(({ node }) => node.id), [hostile]);
    assert.deepEqual((await store.vectorSearch({ user, embedding: [1, 0, 0], k: 1, labels: ['Filtered'] })).map(({ node }) => node.id), ['orthogonal']);
    assert.deepEqual(await store.vectorSearch({ user, embedding: [1, 0, 0], k: 2, labels: ['Topic'] }), []);
    assert.deepEqual(await store.vectorSearch({ user, embedding: [1, 0, 0], k: 0 }), []);
    const isolated = await store.vectorSearch({ user: otherUser, embedding: [1, 0, 0], k: 10 });
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0].node.props.title, 'isolated');
    assert.ok(Math.abs(isolated[0].score) < 1e-5);
  });

  await t.test('close is idempotent and prevents subsequent operations', async () => {
    await store.close();
    await store.close();
    await assert.rejects(store.getNode({ user, id: hostile }), /closed/);
  });
});
