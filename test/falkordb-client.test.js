import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import test from 'node:test';
import { createClient, quoteIdentifier } from '../src/falkordb-client.js';
import { encode, encodeCommand, RespError, RespParser } from '../src/resp.js';
import { createFalkorDBStore } from '../src/store/falkordb-store.js';

const text = (value) => [2, value];
const integer = (value) => [3, value];
const double = (value) => [5, String(value)];
const array = (value) => [6, value];
const map = (value) => [10, Object.entries(value).flat()];
const result = (header, rows, stats = ['Query internal execution time: 0.125 milliseconds']) =>
  [header.map((name) => [1, name]), rows, stats];
const labels = ['Memory', 'Topic', 'Source', 'Filtered'];
const properties = ['id', 'title', 'createdAt', 'embedding', 'w', 'tags', '__proto__'];
const nodeValue = (id = 'note', labelIds = [0], extra = []) =>
  [8, [42, labelIds, [[0, 2, id], [1, 2, 'title'], [3, 12, ['1', '0', '0']], ...extra]]];
const edgeValue = (weight = 0.8) => [7, [17, 0, 42, 43, [[4, 5, String(weight)]]]];

async function serverFor(t, handler) {
  const sockets = new Set();
  const errors = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', (error) => errors.push(error));
    socket.on('close', () => sockets.delete(socket));
    const parser = new RespParser();
    let chain = Promise.resolve();
    socket.on('data', (chunk) => {
      try {
        for (const command of parser.push(chunk)) {
          chain = chain.then(async () => {
            const reply = await handler(command, socket);
            if (reply !== undefined && !socket.destroyed) socket.write(encode(reply));
          }).catch((error) => {
            errors.push(error);
            socket.destroy();
          });
        }
      } catch (error) {
        errors.push(error);
        socket.destroy();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.deepEqual(errors, []);
  });
  return `redis://127.0.0.1:${server.address().port}`;
}

function schemaReply(command, mapping = {}) {
  const cypher = command[2];
  const values = cypher === 'CALL db.labels()' ? mapping.labels ?? labels
    : cypher === 'CALL db.relationshipTypes()' ? mapping.relationships ?? ['ABOUT']
      : cypher === 'CALL db.propertyKeys()' ? mapping.properties ?? properties : null;
  return values ? result(['name'], values.map((name) => [text(name)])) : undefined;
}

test('RESP2 parses every byte boundary, UTF-8 byte lengths, nested values and pipelined replies', () => {
  const values = ['日本語\r\n$\\', 23, null, [], [1, [null, ''], new RespError('ERR nested')], 9223372036854775807n];
  const bytes = Buffer.concat([Buffer.from('+OK\r\n*-1\r\n'), ...values.map(encode)]);
  for (let split = 0; split <= bytes.length; split++) {
    const parser = new RespParser();
    assert.deepEqual([...parser.push(bytes.subarray(0, split)), ...parser.push(bytes.subarray(split))],
      ['OK', null, ...values]);
    parser.finish();
  }
  const parser = new RespParser();
  const replies = [];
  for (const byte of bytes) replies.push(...parser.push(Buffer.from([byte])));
  assert.deepEqual(replies, ['OK', null, ...values]);
  parser.finish();
  assert.equal(encode('日本語').toString(), '$9\r\n日本語\r\n');
  assert.equal(encodeCommand(['GRAPH.QUERY', 'g', 10]).toString(),
    '*3\r\n$11\r\nGRAPH.QUERY\r\n$1\r\ng\r\n$2\r\n10\r\n');
  assert.deepEqual(new RespParser().push(Buffer.from(':+7\r\n:-9223372036854775808\r\n')), [7, -9223372036854775808n]);
});

test('RESP2 rejects malformed frames, truncated replies and unsafe encoder values', () => {
  for (const frame of [
    ':1x\r\n', ':1\n\r\n', ':9223372036854775808\r\n', '$-2\r\n', '*-2\r\n',
    '$9007199254740992\r\n', '$1\r\nx!!', '?x\r\n', '+bad\nline\r\n',
  ]) {
    assert.throws(() => new RespParser().push(Buffer.from(frame)), /RESP/);
  }
  for (const frame of ['$3\r\nab', '*2\r\n:1\r\n', '$0\r\n', '+unfinished']) {
    const parser = new RespParser();
    parser.push(Buffer.from(frame));
    assert.throws(() => parser.finish(), /Truncated/);
  }
  assert.throws(() => encode(undefined), TypeError);
  assert.throws(() => encode(2n ** 63n), TypeError);
  assert.throws(() => encode(new Error('ERR\r\n:1')), TypeError);
  assert.throws(() => encodeCommand([]), TypeError);
  assert.throws(() => encodeCommand(['X', null]), TypeError);
});

test('client decodes official compact entities, scalar types, arrays, maps, paths and vectors', async (t) => {
  const commands = [];
  const value = result(
    ['n', 'r', 's', 'i', 'nil', 'yes', 'no', 'f', 'a', 'm', 'path', 'point', 'v', 'big'],
    [[nodeValue(), edgeValue(), text('日本語'), integer(7), [1, null], [4, 'true'], [4, 'false'],
      double(0.75), array([integer(1), text('$\\'), [1, null], array([double(2.5)]), nodeValue()]),
      map({ a: integer(1), nested: map({ x: text('y') }), __proto__: text('not an own key') }),
      [9, [array([nodeValue()]), array([edgeValue()])]], [11, ['35.6', '139.7']],
      [12, ['0.5', '1']], integer(9223372036854775807n)]],
    ['Nodes created: 1', 'Cached execution: 0', 'Query internal execution time: 0.125 milliseconds']);
  const url = await serverFor(t, (command) => {
    commands.push(command);
    assert.equal(command[0], 'GRAPH.QUERY');
    assert.equal(command[1], 'memory:test');
    assert.equal(command[3], '--compact');
    return schemaReply(command) ?? value;
  });
  const client = createClient({ url });
  t.after(() => client.close());
  const response = await client.query('memory:test', 'MATCH (n)-[r]->() RETURN n, r');
  const expectedNode = { id: 42, labels: ['Memory'], props: { id: 'note', title: 'title', embedding: [1, 0, 0] } };
  const expectedEdge = { id: 17, type: 'ABOUT', from: 42, to: 43, props: { w: 0.8 } };
  assert.deepEqual(response.header, value[0].map((column) => column[1]));
  assert.deepEqual(response.rows[0], [
    expectedNode, expectedEdge, '日本語', 7, null, true, false, 0.75,
    [1, '$\\', null, [2.5], expectedNode], { a: 1, nested: { x: 'y' } },
    { nodes: [expectedNode], edges: [expectedEdge] }, { latitude: 35.6, longitude: 139.7 },
    [0.5, 1], 9223372036854775807n,
  ]);
  assert.deepEqual(response.stats,
    { 'Nodes created': 1, 'Cached execution': 0, 'Query internal execution time': 0.125 });
  await client.query('memory:test', 'RETURN n');
  assert.equal(commands.filter((command) => command[2].startsWith('CALL db.')).length, 3);
});

test('client handles fragmented replies and queries without RETURN', async (t) => {
  const url = await serverFor(t, async (command, socket) => {
    assert.equal(command[3], '--compact');
    const bytes = encode([['Indices created: 1', 'Query internal execution time: 1.5 milliseconds']]);
    for (const byte of bytes) {
      socket.write(Buffer.from([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
  const client = createClient({ url });
  t.after(() => client.close());
  assert.deepEqual(await client.query('g', 'CREATE INDEX FOR (n:Memory) ON (n.id)'), {
    header: [], rows: [], stats: { 'Indices created': 1, 'Query internal execution time': 1.5 },
  });
});

test('client passes escaped strings, numbers, arrays and maps only through CYPHER parameters', async (t) => {
  const commands = [];
  const url = await serverFor(t, (command) => {
    commands.push(command);
    return result(['ok'], [[integer(1)]]);
  });
  const client = createClient({ url });
  t.after(() => client.close());
  const value = '"double" \'single\'\n改行\r\t$param\\path\\n\u0001';
  await client.query('g', 'RETURN $value, vecf32($embedding), $props', {
    value, embedding: [1, -2.5, 1e-7], props: { 'odd`key': 'x', nested: { flag: true } }, empty: null,
  });
  assert.equal(commands[0][2],
    `CYPHER value=${JSON.stringify(value)} embedding=[1,-2.5,1e-7] ` +
    'props={`odd``key`:"x",`nested`:{`flag`:true}} empty=null RETURN $value, vecf32($embedding), $props');
  const attack = '"; MATCH (n) DETACH DELETE n // $id\\';
  await client.query('g', 'RETURN $value', { value: attack });
  assert.equal(commands[1][2], `CYPHER value=${JSON.stringify(attack)} RETURN $value`);
  assert.equal(commands[1].length, 4);
});

test('client rejects invalid URLs, graph names, parameter names and non-JSON-safe parameters', async () => {
  for (const url of ['http://localhost', 'redis://localhost/bad', 'redis://localhost?x=1']) {
    assert.throws(() => createClient({ url }), TypeError);
  }
  const client = createClient({ url: 'redis://127.0.0.1:1' });
  for (const graph of ['', 'memory:x y', 'g\n', 'g\r\n', '日本語', 'g/1', 'g"; DELETE']) {
    await assert.rejects(client.query(graph, 'RETURN 1'), /Graph/);
  }
  await assert.rejects(client.query('g', 'RETURN 1', { 'x=1 RETURN 2 //': 3 }), /parameter name/);
  await assert.rejects(client.query('g', 'RETURN 1', { 'x\n': 3 }), /parameter name/);
  const cyclic = [];
  cyclic.push(cyclic);
  for (const value of [undefined, NaN, Infinity, () => {}, new Date(), cyclic, [undefined], 2n ** 63n]) {
    await assert.rejects(client.query('g', 'RETURN $x', { x: value }), /Cypher parameter/);
  }
  await assert.rejects(client.query('g', ''), /nonempty/);
  assert.equal(quoteIdentifier('a`b'), '`a``b`');
  assert.throws(() => quoteIdentifier('a\\u0060'), /identifier/);
  await client.close();
});

test('client supports percent-encoded ACL and password-only AUTH, database selection and AUTH failures', async (t) => {
  for (const credentials of [
    { auth: 'alice:p%40ss%3A%5C%E6%97%A5', expected: ['AUTH', 'alice', 'p@ss:\\日'] },
    { auth: ':p%40ss', expected: ['AUTH', 'p@ss'] },
  ]) {
    await t.test(credentials.auth, async (t) => {
      const commands = [];
      const base = await serverFor(t, (command) => {
        commands.push(command);
        return command[0] === 'GRAPH.QUERY' ? result(['x'], [[integer(1)]]) : 'OK';
      });
      const client = createClient({ url: base.replace('redis://', `redis://${credentials.auth}@`) + '/2' });
      t.after(() => client.close());
      await client.query('g', 'RETURN 1');
      assert.deepEqual(commands.slice(0, 2), [credentials.expected, ['SELECT', '2']]);
    });
  }
  await t.test('authentication failure rejects the query', async (t) => {
    let queries = 0;
    const base = await serverFor(t, (command) => {
      if (command[0] === 'GRAPH.QUERY') queries++;
      return new RespError('WRONGPASS invalid username-password pair');
    });
    const client = createClient({ url: base.replace('redis://', 'redis://:bad@') });
    t.after(() => client.close());
    await assert.rejects(client.query('g', 'RETURN 1'), /WRONGPASS/);
    assert.equal(queries, 0);
  });
});

test('server errors reject only their query and do not poison concurrent FIFO requests', async (t) => {
  let queries = 0;
  const url = await serverFor(t, () => {
    queries++;
    if (queries === 1) return new RespError('ERR invalid query');
    return result(['i'], [[integer(queries)]]);
  });
  const client = createClient({ url });
  t.after(() => client.close());
  const results = await Promise.allSettled([
    client.query('g', 'BAD'), client.query('g', 'RETURN 2'), client.query('g', 'RETURN 3'),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.ok(results[0].reason instanceof RespError);
  assert.deepEqual(results.slice(1).map((entry) => entry.value.rows), [[[2]], [[3]]]);
});

test('rediss selects TLS transport, supplies SNI and waits for secureConnect before AUTH', async (t) => {
  const commands = [];
  const url = await serverFor(t, (command) => {
    commands.push(command);
    return command[0] === 'AUTH' ? 'OK' : result(['x'], [[integer(1)]]);
  });
  let options;
  let connection;
  const connected = Promise.withResolvers();
  // Replace only the TLS transport; exercise the client handshake gate over local TCP.
  t.mock.method(tls, 'connect', (settings) => {
    options = settings;
    connection = net.createConnection({ host: '127.0.0.1', port: settings.port });
    connection.once('connect', connected.resolve);
    return connection;
  });
  const client = createClient({ url: url.replace('redis://127.0.0.1', 'rediss://alice:pw@localhost') });
  t.after(() => client.close());
  const query = client.query('g', 'RETURN 1');
  await connected.promise;
  assert.equal(options.servername, 'localhost');
  assert.notEqual(options.rejectUnauthorized, false);
  assert.deepEqual(commands, []);
  connection.emit('secureConnect');
  assert.deepEqual((await query).rows, [[1]]);
  assert.deepEqual(commands[0], ['AUTH', 'alice', 'pw']);
});

test('TLS handshake also has a 10-second connection timeout', async (t) => {
  const started = Promise.withResolvers();
  t.mock.method(tls, 'connect', (options) => {
    assert.equal(options.servername, undefined, 'IP addresses must not be sent as SNI');
    started.resolve();
    return new net.Socket();
  });
  const client = createClient({ url: 'rediss://127.0.0.1:1234' });
  t.after(() => client.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(client.query('g', 'RETURN 1'), { code: 'ETIMEDOUT' });
  await started.promise;
  t.mock.timers.tick(10_000);
  await rejected;
  t.mock.timers.reset();
});

test('client refreshes schema caches for new IDs, keeps graphs isolated and resists prototype keys', async (t) => {
  const counts = new Map();
  const url = await serverFor(t, (command) => {
    const graph = command[1];
    if (command[2] === 'CALL db.labels()') {
      const count = (counts.get(graph) ?? 0) + 1;
      counts.set(graph, count);
      return result(['label'], (graph === 'b' ? ['Topic'] : count === 1 ? ['Memory'] : labels).map((v) => [text(v)]));
    }
    if (command[2] === 'CALL db.propertyKeys()') return schemaReply(command);
    return result(['n'], [[nodeValue('note', [command[2] === 'NEW' ? 3 : 0], [[6, 2, 'own-value']])]]);
  });
  const client = createClient({ url });
  t.after(() => client.close());
  const first = await client.query('a', 'OLD');
  assert.equal(first.rows[0][0].props.__proto__, 'own-value');
  assert.equal(Object.getPrototypeOf(first.rows[0][0].props), Object.prototype);
  assert.deepEqual((await client.query('a', 'NEW')).rows[0][0].labels, ['Filtered']);
  assert.deepEqual((await client.query('b', 'OLD')).rows[0][0].labels, ['Topic']);
  assert.deepEqual([...counts], [['a', 2], ['b', 1]]);
});

test('disconnect rejects an in-flight write without replay and the next query reconnects and authenticates', async (t) => {
  let queries = 0;
  let auths = 0;
  const url = await serverFor(t, (command, socket) => {
    if (command[0] === 'AUTH') {
      auths++;
      return 'OK';
    }
    if (schemaReply(command)) return schemaReply(command);
    queries++;
    if (queries === 1) socket.destroy();
    else return result(['n'], [[nodeValue()]]);
  });
  const client = createClient({ url: url.replace('redis://', 'redis://:password@') });
  t.after(() => client.close());
  await assert.rejects(client.query('g', 'CREATE (:Memory)'), /connection closed/);
  assert.equal((await client.query('g', 'MATCH (n) RETURN n')).rows[0][0].props.id, 'note');
  assert.equal(queries, 2);
  assert.equal(auths, 2);
});

test('reconnecting invalidates schema mappings even when a recreated graph reuses old IDs', async (t) => {
  let recreated = false;
  let labelReads = 0;
  const url = await serverFor(t, (command, socket) => {
    if (command[2] === 'DROP_CONNECTION') {
      recreated = true;
      socket.destroy();
      return;
    }
    if (command[2] === 'CALL db.labels()') labelReads++;
    return schemaReply(command, { labels: [recreated ? 'Topic' : 'Memory'] }) ??
      result(['n'], [[nodeValue()]]);
  });
  const client = createClient({ url });
  t.after(() => client.close());
  assert.deepEqual((await client.query('g', 'RETURN n')).rows[0][0].labels, ['Memory']);
  await assert.rejects(client.query('g', 'DROP_CONNECTION'), /connection closed/);
  assert.deepEqual((await client.query('g', 'RETURN n')).rows[0][0].labels, ['Topic']);
  assert.equal(labelReads, 2);
});

test('invalid RESP disconnects cleanly and later queries can reconnect', async (t) => {
  let queries = 0;
  const url = await serverFor(t, (command, socket) => {
    if (++queries === 1) socket.write('$1\r\nx!!');
    else return result(['x'], [[integer(1)]]);
  });
  const client = createClient({ url });
  t.after(() => client.close());
  await assert.rejects(client.query('g', 'RETURN 1'), /RESP bulk terminator/);
  assert.deepEqual((await client.query('g', 'RETURN 1')).rows, [[1]]);
});

test('malformed and unsupported compact responses fail explicitly and the queue recovers', async (t) => {
  const replies = [
    [],
    result(['x'], [[[99, 'unsupported']]]),
    result(['x'], [[[4, 'maybe']]]),
    result(['x'], [[integer(1), integer(2)]]),
    result(['x'], [[integer(7)]]),
  ];
  const url = await serverFor(t, () => replies.shift());
  const client = createClient({ url });
  t.after(() => client.close());
  for (const pattern of [/result set/, /value type/, /boolean/, /row width/]) {
    await assert.rejects(client.query('g', 'RETURN x'), pattern);
  }
  assert.deepEqual((await client.query('g', 'RETURN 7')).rows, [[7]]);
});

test('10-second command timeout destroys the connection and allows a clean reconnect', async (t) => {
  const received = Promise.withResolvers();
  const url = await serverFor(t, (command) => {
    if (command[2] === 'HANG') received.resolve();
    else return result(['x'], [[integer(1)]]);
  });
  const client = createClient({ url });
  t.after(() => client.close());
  await client.query('g', 'RETURN 1');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(client.query('g', 'HANG'), { code: 'ETIMEDOUT' });
  await received.promise;
  t.mock.timers.tick(9_999);
  t.mock.timers.tick(1);
  await rejected;
  t.mock.timers.reset();
  assert.deepEqual((await client.query('g', 'RETURN 1')).rows, [[1]]);
});

test('close cancels pending and queued requests, is idempotent and forbids reuse', async (t) => {
  const received = Promise.withResolvers();
  const url = await serverFor(t, () => { received.resolve(); });
  const client = createClient({ url });
  const first = assert.rejects(client.query('g', 'HANG'), /client is closed/);
  const second = assert.rejects(client.query('g', 'QUEUED'), /client is closed/);
  await received.promise;
  await client.close();
  await Promise.all([first, second]);
  await client.close();
  await assert.rejects(client.query('g', 'RETURN 1'), /closed/);
});

test('store parameterizes values and filters, decodes every contract result and preserves real edge direction', async (t) => {
  const commands = [];
  const url = await serverFor(t, (command) => {
    const schema = schemaReply(command);
    if (schema) return schema;
    commands.push(command);
    const cypher = command[2];
    assert.equal(command[1], 'memory:unit');
    if (cypher.includes('RETURN count(n)')) return result(['count'], [[integer(20)]]);
    if (cypher.includes('db.idx.vector.queryNodes')) {
      return result(['node', 'score'], [
        [nodeValue('opposite'), double(2)], [nodeValue('same'), double(0)], [nodeValue('orthogonal'), double(1)],
      ]);
    }
    if (cypher.includes('RETURN DISTINCT')) {
      return result(['n', 'r', 'from', 'to'], [[nodeValue('neighbor'), edgeValue(), text('neighbor'), text('note')]]);
    }
    if (cypher.includes('MERGE (a)-')) return result(['r', 'from', 'to'], [[edgeValue(), text('note'), text('topic')]]);
    if (cypher.includes('id="absent"')) return result(['n'], []);
    return result(['n'], [[nodeValue()]]);
  });
  const store = createFalkorDBStore({ url });
  t.after(() => store.close());
  const expectedNode = { id: 'note', labels: ['Memory'], props: { title: 'title' } };
  assert.deepEqual(await store.upsertNode({
    user: 'unit', id: 'note', labels: ['Memory', 'Custom`Label'], props: { title: '"\n日本語$\\' }, embedding: [1, 0, 0],
  }), expectedNode);
  assert.match(commands[0][2], /id="note" props=\{`title`:"\\"\\n日本語\$\\\\"\} embedding=\[1,0,0\]/);
  assert.match(commands[0][2], /SET n:`Memory`:`Custom``Label` SET n.embedding = vecf32\(\$embedding\)/);
  assert.deepEqual(await store.getNode({ user: 'unit', id: 'note' }), expectedNode);
  assert.equal(await store.getNode({ user: 'unit', id: 'absent' }), null);
  assert.deepEqual(await store.findNodes({
    user: 'unit', label: 'Memory', where: { 'x`) DELETE n //': '"; DELETE', absent: null }, limit: 2,
  }), [expectedNode]);
  const find = commands.at(-1)[2];
  assert.ok(find.endsWith('MATCH (n) WHERE $label IN labels(n) AND n[$key0] = $value0 AND n[$key1] IS NULL RETURN n LIMIT $limit'));
  assert.ok(find.includes('key0="x`) DELETE n //"'));
  await store.findNodes({ user: 'unit' });
  assert.equal(commands.at(-1)[2], 'MATCH (n) RETURN n');
  assert.deepEqual(await store.listNodes({ user: 'unit', label: 'Memory', sinceIso: '2026-01-01', limit: 3 }), [expectedNode]);
  assert.ok(commands.at(-1)[2].endsWith(
    'WHERE $label IN labels(n) AND n.createdAt >= $sinceIso RETURN n ORDER BY n.createdAt DESC, n.id LIMIT $limit'));
  assert.deepEqual(await store.addEdge({
    user: 'unit', from: 'note', to: 'topic', type: 'ABOUT', props: { w: 0.8 },
  }), { from: 'note', to: 'topic', type: 'ABOUT', props: { w: 0.8 } });
  assert.ok(commands.at(-1)[2].endsWith(
    'MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:`ABOUT`]->(b) SET r += $props RETURN r, a.id, b.id'));
  assert.deepEqual(await store.neighbors({ user: 'unit', id: 'note', types: ['ABOUT'], limit: 5 }), [{
    node: { ...expectedNode, id: 'neighbor' },
    edge: { from: 'neighbor', to: 'note', type: 'ABOUT', props: { w: 0.8 } },
  }]);
  assert.match(commands.at(-1)[2], /MATCH \(a \{id: \$id\}\)-\[r\]-\(n\) WHERE type\(r\) IN \$types/);
  assert.match(commands.at(-1)[2], /ORDER BY coalesce\(r.w, 0\) DESC/);
  const matches = await store.vectorSearch({ user: 'unit', embedding: [1, 0, 0], k: 3, labels: ['Filtered'] });
  assert.deepEqual(matches.map(({ node, score }) => [node.id, score]), [['same', 1], ['orthogonal', 0], ['opposite', -1]]);
  assert.ok(commands.at(-1)[2].includes('candidates=20'));
  assert.ok(commands.at(-1)[2].includes('WHERE any(label IN labels(node) WHERE label IN $labels)'));
  const before = commands.length;
  assert.deepEqual(await store.vectorSearch({ user: 'unit', embedding: [1, 0, 0], k: 0 }), []);
  assert.equal(commands.length, before);
});

function indexRows(dim = 3, similarity = 'cosine', status = 'OPERATIONAL') {
  const rows = ['Memory', 'Topic', 'Source'].map((label) => [
    text(label), array([text('id')]), map({ id: array([text('RANGE')]) }), map({}), text('NODE'), text(status),
  ]);
  rows.push([
    text('Memory'), array([text('embedding')]), map({ embedding: array([text('VECTOR')]) }),
    map({ embedding: map({ dimension: integer(dim), similarityFunction: text(similarity) }) }),
    text('NODE'), text(status),
  ]);
  return result(['label', 'properties', 'types', 'options', 'entitytype', 'status'], rows);
}

test('ensureIndexes creates cosine/vector and id indexes, waits for readiness and is idempotent', async (t) => {
  const creates = [];
  let reads = 0;
  const url = await serverFor(t, (command) => {
    if (command[2].startsWith('CALL db.indexes()')) {
      reads++;
      if (reads === 1) return result(['label', 'properties', 'types', 'options', 'entitytype', 'status'], []);
      return indexRows(3, 'cosine', reads === 2 ? 'UNDER CONSTRUCTION' : 'OPERATIONAL');
    }
    creates.push(command[2]);
    return [['Indices created: 1']];
  });
  const store = createFalkorDBStore({ url });
  t.after(() => store.close());
  assert.equal(await store.ensureIndexes({ user: 'unit', dim: 3 }), undefined);
  assert.equal(creates.length, 4);
  assert.equal(creates[0],
    'CYPHER dim=3 similarity="cosine" CREATE VECTOR INDEX FOR (n:Memory) ON (n.embedding) ' +
    'OPTIONS {dimension: $dim, similarityFunction: $similarity}');
  for (const label of ['Memory', 'Topic', 'Source']) {
    assert.ok(creates.includes(`CREATE INDEX FOR (n:${label}) ON (n.id)`));
  }
  await store.ensureIndexes({ user: 'unit', dim: 3 });
  assert.equal(creates.length, 4);
  await assert.rejects(store.ensureIndexes({ user: 'unit', dim: 4 }), /incompatible/);
});

test('store surfaces backend errors, missing endpoints, incompatible indexes and invalid distances', async (t) => {
  const url = await serverFor(t, (command) => {
    if (command[2].startsWith('CALL db.indexes()')) return indexRows(3, 'euclidean');
    if (command[2].includes('MERGE (a)-')) return result(['r', 'from', 'to'], []);
    if (command[2].includes('db.idx.vector.queryNodes')) return result(['node', 'score'], [[nodeValue(), double(NaN)]]);
    return schemaReply(command) ?? new RespError('ERR backend failure');
  });
  const store = createFalkorDBStore({ url });
  t.after(() => store.close());
  await assert.rejects(store.getNode({ user: 'unit', id: 'note' }), /backend failure/);
  await assert.rejects(store.addEdge({ user: 'unit', from: 'a', to: 'b', type: 'ABOUT' }), /endpoints/);
  await assert.rejects(store.ensureIndexes({ user: 'unit', dim: 3 }), /incompatible/);
  await assert.rejects(store.vectorSearch({ user: 'unit', embedding: [1, 0, 0], k: 1 }), /distance/);
});

test('store rejects unsafe graph names and invalid arguments before opening a network connection', async () => {
  const store = createFalkorDBStore({ url: 'redis://127.0.0.1:1' });
  for (const method of ['ensureIndexes', 'upsertNode', 'getNode', 'findNodes', 'listNodes', 'addEdge', 'neighbors', 'vectorSearch']) {
    await assert.rejects(store[method]({ user: 'bad user' }), /Graph/);
  }
  for (const dim of [0, 4097, 1.5, '3']) await assert.rejects(store.ensureIndexes({ user: 'u', dim }), /dim/);
  for (const embedding of [[], [0, 0], [NaN], [Infinity], [1e50], [1, undefined]]) {
    await assert.rejects(store.vectorSearch({ user: 'u', embedding, k: 1 }), /embedding/);
  }
  await assert.rejects(store.vectorSearch({ user: 'u', embedding: [1], k: -1 }), /k/);
  await assert.rejects(store.neighbors({ user: 'u', id: 'a', limit: -1 }), /limit/);
  await assert.rejects(store.findNodes({ user: 'u', limit: 1.5 }), /limit/);
  await assert.rejects(store.listNodes({ user: 'u', limit: -1 }), /limit/);
  await assert.rejects(store.upsertNode({ user: 'u', id: 'a', labels: ['Memory'], props: { id: 'x' } }), /reserved/);
  await assert.rejects(store.upsertNode({ user: 'u', id: 'a', labels: ['Topic'], props: {}, embedding: [1] }), /Only Memory/);
  await assert.rejects(store.findNodes({ user: 'u', where: { nested: {} } }), /flat/);
  await store.close();
  await store.close();
  await assert.rejects(store.getNode({ user: 'u', id: 'a' }), /closed/);
  await assert.rejects(store.vectorSearch({ user: 'u', embedding: [1], k: 0 }), /closed/);
});
