function string(value, name) {
  if (typeof value !== "string" || !value) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
}

function dimension(dim) {
  if (!Number.isSafeInteger(dim) || dim < 1) {
    throw new RangeError("dim must be a positive integer");
  }
}

function limitValue(limit = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("limit must be a nonnegative integer");
  }
  return limit;
}

function flatProps(props) {
  if (
    !props ||
    typeof props !== "object" ||
    Array.isArray(props) ||
    Object.values(props).some(
      (value) =>
        value !== null &&
        !["string", "boolean", "number"].includes(typeof value),
    ) ||
    Object.values(props).some((value) => typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("props must be a flat JSON-safe object");
  }
}

function labelsValue(labels) {
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || !label)) {
    throw new TypeError("labels must be an array of nonempty strings");
  }
}

function vectorValue(embedding, dim) {
  if (
    !Array.isArray(embedding) ||
    embedding.length === 0 ||
    (dim !== undefined && embedding.length !== dim) ||
    !embedding.every(Number.isFinite)
  ) {
    throw new TypeError("embedding must be a finite vector with the indexed dimension");
  }
}

function normalizedVector(vector) {
  let scale = 0;
  for (const value of vector) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return vector.map(() => 0);
  const scaled = vector.map((value) => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return scaled.map((value) => value / norm);
}

function timestamp(value) {
  return value === undefined ? -Infinity : Date.parse(value);
}

export function createMemoryStore() {
  const users = new Map();
  let closed = false;

  function graph(user, create = false) {
    if (closed) throw new Error("Store is closed");
    string(user, "user");
    if (!users.has(user) && create) {
      users.set(user, {
        nodes: new Map(),
        embeddings: new Map(),
        edges: new Map(),
        adjacent: new Map(),
        dim: undefined,
      });
    }
    return users.get(user);
  }

  return {
    async ensureIndexes({ user, dim }) {
      dimension(dim);
      const data = graph(user, true);
      if (data.dim !== undefined && data.dim !== dim) {
        throw new RangeError("The indexed embedding dimension cannot change");
      }
      for (const { vector } of data.embeddings.values()) vectorValue(vector, dim);
      data.dim = dim;
    },

    async upsertNode({ user, id, labels, props, embedding }) {
      string(id, "id");
      labelsValue(labels);
      flatProps(props);
      if (Object.hasOwn(props, "embedding")) {
        throw new TypeError("embedding must be supplied separately from props");
      }
      const data = graph(user, true);
      if (embedding !== undefined) vectorValue(embedding, data.dim);
      const previous = data.nodes.get(id);
      const node = {
        id,
        labels: [...new Set([...(previous?.labels ?? []), ...labels])],
        props: { ...previous?.props, ...props },
      };
      data.nodes.set(id, node);
      if (embedding !== undefined) {
        data.embeddings.set(id, { vector: normalizedVector(embedding) });
      }
      return structuredClone(node);
    },

    async getNode({ user, id }) {
      string(id, "id");
      return structuredClone(graph(user)?.nodes.get(id) ?? null);
    },

    async findNodes({ user, label, where = {}, limit }) {
      const count = limitValue(limit);
      flatProps(where);
      const data = graph(user);
      return structuredClone(
        [...(data?.nodes.values() ?? [])]
          .filter(
            (node) =>
              (label === undefined || node.labels.includes(label)) &&
              Object.entries(where).every(([key, value]) => node.props[key] === value),
          )
          .slice(0, count),
      );
    },

    async listNodes({ user, label, sinceIso, limit }) {
      const count = limitValue(limit);
      const since = timestamp(sinceIso);
      if (Number.isNaN(since)) throw new TypeError("sinceIso must be an ISO date");
      const data = graph(user);
      return structuredClone(
        [...(data?.nodes.values() ?? [])]
          .filter(
            (node) =>
              (label === undefined || node.labels.includes(label)) &&
              (sinceIso === undefined || timestamp(node.props.createdAt) >= since),
          )
          .sort((a, b) => timestamp(b.props.createdAt) - timestamp(a.props.createdAt))
          .slice(0, count),
      );
    },

    async addEdge({ user, from, to, type, props = {} }) {
      string(from, "from");
      string(to, "to");
      string(type, "type");
      flatProps(props);
      const data = graph(user);
      if (!data?.nodes.has(from) || !data.nodes.has(to)) {
        throw new Error("Both edge endpoints must exist in the user's graph");
      }
      const key = JSON.stringify([from, to, type]);
      const previous = data.edges.get(key);
      const edge = { from, to, type, props: { ...previous?.props, ...props } };
      data.edges.set(key, edge);
      for (const id of new Set([from, to])) {
        if (!data.adjacent.has(id)) data.adjacent.set(id, new Map());
        data.adjacent.get(id).set(key, edge);
      }
      return structuredClone(edge);
    },

    async neighbors({ user, id, types, limit }) {
      string(id, "id");
      const count = limitValue(limit);
      if (types !== undefined) labelsValue(types);
      const data = graph(user);
      const edges = [...(data?.adjacent.get(id)?.values() ?? [])]
        .filter((edge) => types === undefined || types.includes(edge.type))
        .sort((a, b) => (b.props.w ?? 0) - (a.props.w ?? 0))
        .slice(0, count);
      return structuredClone(
        edges.map((edge) => ({
          node: data.nodes.get(edge.from === id ? edge.to : edge.from),
          edge,
        })),
      );
    },

    async vectorSearch({ user, embedding, k, labels }) {
      const count = limitValue(k);
      if (labels !== undefined) labelsValue(labels);
      const data = graph(user);
      vectorValue(embedding, data?.dim);
      const query = normalizedVector(embedding);
      const results = [];
      for (const [id, stored] of data?.embeddings ?? []) {
        const node = data.nodes.get(id);
        if (labels !== undefined && !labels.some((label) => node.labels.includes(label))) continue;
        if (query.length !== stored.vector.length) {
          throw new TypeError("embedding must match the stored vector dimension");
        }
        let dot = 0;
        for (let index = 0; index < query.length; index += 1) {
          dot += query[index] * stored.vector[index];
        }
        results.push({ node, score: Math.max(-1, Math.min(1, dot)) });
      }
      return structuredClone(results.sort((a, b) => b.score - a.score).slice(0, count));
    },

    async close() {
      users.clear();
      closed = true;
    },
  };
}
