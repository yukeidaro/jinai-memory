import { setTimeout as delay } from 'node:timers/promises';
import { createClient, quoteIdentifier, validateGraphName } from '../falkordb-client.js';

function string(value, name) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${name} must be a nonempty string`);
}

function strings(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of strings`);
  for (const item of value) string(item, name);
}

function limitValue(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative integer`);
}

function flatProps(props, reserved = []) {
  if (!props || typeof props !== 'object' || Array.isArray(props) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(props))) {
    throw new TypeError('props must be a flat JSON-safe object');
  }
  const scalar = (value) => value === null || typeof value === 'string' ||
    typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  for (const [key, value] of Object.entries(props)) {
    if (reserved.includes(key)) throw new TypeError(`props.${key} is reserved`);
    if (!scalar(value) && !(Array.isArray(value) && Array.from(value).every(scalar))) {
      throw new TypeError('props must contain only JSON scalars or flat arrays of scalars');
    }
  }
}

function vector(embedding) {
  if (!Array.isArray(embedding) || !embedding.length || embedding.length > 4096 ||
      !Array.from(embedding).every((item) => typeof item === 'number' && Number.isFinite(Math.fround(item))) ||
      !embedding.some((item) => Math.fround(item) !== 0)) {
    throw new TypeError('embedding must be a nonzero vector of 1-4096 finite float32 numbers');
  }
}

function node(entity) {
  const { id, embedding, ...props } = entity.props;
  if (typeof id !== 'string') throw new Error('Stored node is missing its string id');
  return { id, labels: entity.labels, props };
}

function edge(entity, from, to) {
  return { from, to, type: entity.type, props: entity.props };
}

export function createFalkorDBStore({ url }) {
  const client = createClient({ url });
  let closed = false;
  function graphFor(user) {
    if (closed) throw new Error('FalkorDB store is closed');
    string(user, 'user');
    return validateGraphName(`memory:${user}`);
  }
  const readIndexes = async (graph) => {
    const { rows } = await client.query(graph,
      'CALL db.indexes() YIELD label, properties, types, options, entitytype, status ' +
      'RETURN label, properties, types, options, entitytype, status');
    return rows.map(([label, properties, types, options, entitytype, status]) =>
      ({ label, properties, types, options, entitytype, status }));
  };
  const hasIndex = (indexes, label, property, type) => indexes.find((index) =>
    index.entitytype === 'NODE' && index.label === label && index.types[property]?.includes(type));

  return {
    async ensureIndexes({ user, dim }) {
      const graph = graphFor(user);
      if (!Number.isSafeInteger(dim) || dim < 1 || dim > 4096) throw new TypeError('dim must be 1-4096');
      let indexes = await readIndexes(graph);
      const existing = hasIndex(indexes, 'Memory', 'embedding', 'VECTOR');
      if (existing && (existing.options.embedding.dimension !== dim ||
          existing.options.embedding.similarityFunction !== 'cosine')) {
        throw new Error('Existing Memory.embedding index has incompatible dimension or similarity function');
      }
      if (!existing) {
        await client.query(graph,
          'CREATE VECTOR INDEX FOR (n:Memory) ON (n.embedding) ' +
          'OPTIONS {dimension: $dim, similarityFunction: $similarity}', { dim, similarity: 'cosine' });
      }
      for (const label of ['Memory', 'Topic', 'Source']) {
        if (!hasIndex(indexes, label, 'id', 'RANGE')) {
          await client.query(graph, `CREATE INDEX FOR (n:${label}) ON (n.id)`);
        }
      }
      const deadline = Date.now() + 10_000;
      for (;;) {
        indexes = await readIndexes(graph);
        const required = [
          hasIndex(indexes, 'Memory', 'embedding', 'VECTOR'),
          ...['Memory', 'Topic', 'Source'].map((label) => hasIndex(indexes, label, 'id', 'RANGE')),
        ];
        if (required.every((index) => index?.status === 'OPERATIONAL')) return;
        if (Date.now() >= deadline) throw new Error('FalkorDB indexes did not become operational within 10000 ms');
        await delay(25);
      }
    },

    async upsertNode({ user, id, labels, props, embedding }) {
      const graph = graphFor(user);
      string(id, 'id');
      strings(labels, 'labels');
      flatProps(props, ['id', 'embedding']);
      if (embedding !== undefined) {
        vector(embedding);
        if (!labels.includes('Memory')) throw new TypeError('Only Memory nodes may have an embedding');
      }
      const labelClause = labels.length ? ` SET n:${[...new Set(labels)].map(quoteIdentifier).join(':')}` : '';
      const embeddingClause = embedding === undefined ? '' : ' SET n.embedding = vecf32($embedding)';
      const params = { id, props, ...(embedding === undefined ? {} : { embedding }) };
      const { rows } = await client.query(graph,
        `MERGE (n {id: $id}) SET n += $props${labelClause}${embeddingClause} RETURN n`, params);
      if (rows.length !== 1) throw new Error('Node upsert did not return exactly one node');
      return node(rows[0][0]);
    },

    async getNode({ user, id }) {
      const graph = graphFor(user);
      string(id, 'id');
      const { rows } = await client.query(graph, 'MATCH (n {id: $id}) RETURN n', { id });
      return rows.length ? node(rows[0][0]) : null;
    },

    async findNodes({ user, label, where = {}, limit }) {
      const graph = graphFor(user);
      if (label !== undefined) string(label, 'label');
      flatProps(where);
      const params = {};
      const conditions = [];
      if (label !== undefined) {
        params.label = label;
        conditions.push('$label IN labels(n)');
      }
      Object.entries(where).forEach(([key, value], i) => {
        params[`key${i}`] = key;
        params[`value${i}`] = value;
        conditions.push(value === null ? `n[$key${i}] IS NULL` : `n[$key${i}] = $value${i}`);
      });
      if (limit !== undefined) {
        limitValue(limit, 'limit');
        params.limit = limit;
      }
      const { rows } = await client.query(graph,
        `MATCH (n)${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} RETURN n` +
        (limit === undefined ? '' : ' LIMIT $limit'), params);
      return rows.map(([entity]) => node(entity));
    },

    async listNodes({ user, label, sinceIso, limit }) {
      const graph = graphFor(user);
      const params = {};
      const conditions = [];
      if (label !== undefined) {
        string(label, 'label');
        params.label = label;
        conditions.push('$label IN labels(n)');
      }
      if (sinceIso !== undefined) {
        string(sinceIso, 'sinceIso');
        params.sinceIso = sinceIso;
        conditions.push('n.createdAt >= $sinceIso');
      }
      if (limit !== undefined) {
        limitValue(limit, 'limit');
        params.limit = limit;
      }
      const { rows } = await client.query(graph,
        `MATCH (n)${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ` +
        'RETURN n ORDER BY n.createdAt DESC, n.id' + (limit === undefined ? '' : ' LIMIT $limit'), params);
      return rows.map(([entity]) => node(entity));
    },

    async addEdge({ user, from, to, type, props = {} }) {
      const graph = graphFor(user);
      string(from, 'from');
      string(to, 'to');
      flatProps(props);
      const { rows } = await client.query(graph,
        `MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${quoteIdentifier(type)}]->(b) ` +
        'SET r += $props RETURN r, a.id, b.id', { from, to, props });
      if (rows.length !== 1) throw new Error('Cannot add edge: both endpoints must exist uniquely');
      return edge(rows[0][0], rows[0][1], rows[0][2]);
    },

    async removeEdges({ user, id, types, direction }) {
      const graph = graphFor(user);
      string(id, 'id');
      strings(types, 'types');
      if (direction !== 'out' && direction !== 'both') {
        throw new TypeError('direction must be "out" or "both"');
      }
      await client.query(graph,
        `MATCH (a {id: $id})-[r]${direction === 'out' ? '->' : '-'}() ` +
        'WHERE type(r) IN $types DELETE r', { id, types });
    },

    async neighbors({ user, id, types, limit }) {
      const graph = graphFor(user);
      string(id, 'id');
      if (types !== undefined) strings(types, 'types');
      limitValue(limit, 'limit');
      const params = { id, limit, ...(types === undefined ? {} : { types }) };
      const { rows } = await client.query(graph,
        'MATCH (a {id: $id})-[r]-(n)' + (types === undefined ? '' : ' WHERE type(r) IN $types') +
        ' RETURN DISTINCT n, r, startNode(r).id, endNode(r).id ' +
        'ORDER BY coalesce(r.w, 0) DESC, n.id LIMIT $limit', params);
      return rows.map(([entity, relation, from, to]) => ({ node: node(entity), edge: edge(relation, from, to) }));
    },

    async vectorSearch({ user, embedding, k, labels }) {
      const graph = graphFor(user);
      vector(embedding);
      limitValue(k, 'k');
      if (labels !== undefined) strings(labels, 'labels');
      if (k === 0) return [];
      let candidates = k;
      const filtered = Boolean(labels?.length);
      // The vector procedure has no prefilter. Fetch all candidates when filtering
      // so a nearer node of another label cannot hide a valid top-k match.
      if (filtered) {
        const { rows } = await client.query(graph,
          'MATCH (n:Memory) WHERE n.embedding IS NOT NULL RETURN count(n)');
        candidates = Math.max(k, Number(rows[0][0]));
      }
      const { rows } = await client.query(graph,
        'CALL db.idx.vector.queryNodes($label, $attribute, $candidates, vecf32($embedding)) YIELD node, score' +
        (filtered ? ' WHERE any(label IN labels(node) WHERE label IN $labels)' : '') +
        ' RETURN node, score ORDER BY score ASC LIMIT $k',
        { label: 'Memory', attribute: 'embedding', candidates, embedding, k, ...(filtered ? { labels } : {}) });
      // The procedure yields cosine distance, despite the "score" name in the docs.
      // https://github.com/FalkorDB/FalkorDB/blob/master/src/procedures/proc_vector_query.c
      return rows.map(([entity, distance]) => {
        if (typeof distance !== 'number' || !Number.isFinite(distance)) {
          throw new Error('Invalid vector distance returned by FalkorDB');
        }
        return { node: node(entity), score: Math.max(-1, Math.min(1, 1 - distance)) };
      }).sort((a, b) => b.score - a.score);
    },

    async close() {
      closed = true;
      await client.close();
    },
  };
}
