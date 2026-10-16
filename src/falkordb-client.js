import net from 'node:net';
import tls from 'node:tls';
import { encodeCommand, RespError, RespParser } from './resp.js';

const TIMEOUT_MS = 10_000;

export function validateGraphName(graph) {
  if (typeof graph !== 'string' || !graph.length || /[^A-Za-z0-9:_-]/.test(graph)) {
    throw new TypeError('Graph names may contain only A-Z, a-z, 0-9, colon, underscore and hyphen');
  }
  return graph;
}

// Cypher schema identifiers cannot be parameters. Double backticks quote them.
export function quoteIdentifier(name) {
  if (typeof name !== 'string' || !name.length || /[\0\\]/.test(name)) {
    throw new TypeError('Invalid Cypher identifier');
  }
  return `\`${name.replaceAll('`', '``')}\``;
}

function literal(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint' && value >= -(2n ** 63n) && value < 2n ** 63n) {
    return String(value);
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError('Cyclic Cypher parameter');
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      result = `[${Array.from(value, (item) => literal(item, ancestors)).join(',')}]`;
    } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      result = `{${Object.entries(value).map(([key, item]) =>
        `${quoteIdentifier(key)}:${literal(item, ancestors)}`).join(',')}}`;
    } else {
      throw new TypeError('Cypher parameters must be JSON-safe values');
    }
    ancestors.delete(value);
    return result;
  }
  throw new TypeError('Cypher parameters must be finite, JSON-safe values');
}

function parameterized(cypher, params) {
  if (typeof cypher !== 'string' || !cypher.trim()) throw new TypeError('Cypher must be nonempty');
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Parameters must be an object');
  }
  const entries = Object.entries(params).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(name)) {
      throw new TypeError('Invalid parameter name');
    }
    return `${name}=${literal(value)}`;
  });
  return entries.length ? `CYPHER ${entries.join(' ')} ${cypher}` : cypher;
}

function statistics(lines) {
  return Object.fromEntries(lines.map((line) => {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid FalkorDB statistic');
    const numeric = /^(-?\d+(?:\.\d+)?)(?: milliseconds)?$/.exec(match[2]);
    return [match[1], numeric ? Number(numeric[1]) : match[2]];
  }));
}

export function createClient({ url }) {
  const address = new URL(url);
  if (!['redis:', 'rediss:'].includes(address.protocol)) {
    throw new TypeError('FalkorDB URL must use redis:// or rediss://');
  }
  if (!address.hostname || address.search || address.hash ||
      (address.pathname && address.pathname !== '/' && !/^\/\d+$/.test(address.pathname))) {
    throw new TypeError('Invalid FalkorDB URL');
  }
  const host = address.hostname.replace(/^\[|\]$/g, '');
  const port = Number(address.port || 6379);
  const username = decodeURIComponent(address.username);
  const password = decodeURIComponent(address.password);
  const database = Number(address.pathname.slice(1) || 0);
  if (!Number.isSafeInteger(database)) throw new TypeError('Invalid Redis database');
  let socket = null;
  let connecting = null;
  let closed = false;
  let queue = Promise.resolve();
  const pending = [];
  const schemas = new Map();

  function disconnect(error, connection = socket) {
    if (socket !== connection) return;
    socket = null;
    schemas.clear();
    connection?.destroy();
    for (const request of pending.splice(0)) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  function send(args) {
    const bytes = encodeCommand(args);
    return new Promise((resolve, reject) => {
      if (!socket || socket.destroyed) {
        reject(new Error('FalkorDB connection is closed'));
        return;
      }
      const connection = socket;
      const timer = setTimeout(() => {
        const error = new Error(`FalkorDB command timed out after ${TIMEOUT_MS} ms`);
        error.code = 'ETIMEDOUT';
        // A late reply must never be assigned to a subsequent request.
        disconnect(error, connection);
      }, TIMEOUT_MS);
      pending.push({ resolve, reject, timer });
      connection.write(bytes, (error) => {
        if (error) disconnect(error, connection);
      });
    });
  }

  async function connect() {
    if (closed) throw new Error('FalkorDB client is closed');
    if (connecting) return connecting;
    if (socket && !socket.destroyed) return;
    connecting = (async () => {
      const options = { host, port };
      const secure = address.protocol === 'rediss:';
      if (secure && !net.isIP(host)) options.servername = host;
      const connection = secure ? tls.connect(options) : net.createConnection(options);
      socket = connection;
      schemas.clear();
      connection.setNoDelay(true);
      const parser = new RespParser();
      let rejectConnect;
      connection.on('error', (error) => {
        rejectConnect?.(error);
        disconnect(error, connection);
      });
      connection.on('close', () => {
        const error = new Error('FalkorDB connection closed before reply');
        rejectConnect?.(error);
        disconnect(error, connection);
      });
      connection.on('data', (chunk) => {
        if (socket !== connection) return;
        try {
          for (const reply of parser.push(chunk)) {
            const request = pending.shift();
            if (!request) throw new Error('Unexpected RESP reply');
            clearTimeout(request.timer);
            if (reply instanceof RespError) request.reject(reply);
            else request.resolve(reply);
          }
        } catch (error) {
          rejectConnect?.(error);
          disconnect(error, connection);
        }
      });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new Error(`FalkorDB connection timed out after ${TIMEOUT_MS} ms`);
            error.code = 'ETIMEDOUT';
            disconnect(error, connection);
            reject(error);
          }, TIMEOUT_MS);
          rejectConnect = (error) => {
            clearTimeout(timer);
            reject(error);
          };
          connection.once(secure ? 'secureConnect' : 'connect', () => {
            clearTimeout(timer);
            rejectConnect = null;
            resolve();
          });
        });
        if (username || password) {
          const reply = await send(username ? ['AUTH', username, password] : ['AUTH', password]);
          if (reply !== 'OK') throw new Error('Unexpected AUTH reply');
        }
        if (database !== 0) {
          if (await send(['SELECT', database]) !== 'OK') throw new Error('Unexpected SELECT reply');
        }
      } catch (error) {
        disconnect(error, connection);
        throw error;
      }
    })();
    try {
      await connecting;
    } finally {
      connecting = null;
    }
  }

  async function rawQuery(graph, cypher) {
    await connect();
    const result = await send(['GRAPH.QUERY', graph, cypher, '--compact']);
    if (!Array.isArray(result) || ![1, 3].includes(result.length)) {
      throw new Error('Invalid FalkorDB result set');
    }
    return result;
  }

  async function decodeResult(graph, result) {
    if (result.length === 1) return { header: [], rows: [], stats: statistics(result[0]) };
    let schema = schemas.get(graph);
    if (!schema) {
      schema = { labels: [], relationships: [], properties: [] };
      schemas.set(graph, schema);
    }
    async function name(kind, id) {
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid FalkorDB schema ID');
      if (id >= schema[kind].length) {
        const procedure = { labels: 'labels', relationships: 'relationshipTypes', properties: 'propertyKeys' }[kind];
        const mapping = await rawQuery(graph, `CALL db.${procedure}()`);
        if (mapping.length !== 3) throw new Error('Invalid FalkorDB schema response');
        schema[kind] = mapping[1].map((row) => {
          if (row[0]?.[0] !== 2 || typeof row[0][1] !== 'string') {
            throw new Error('Invalid FalkorDB schema name');
          }
          return row[0][1];
        });
      }
      if (schema[kind][id] === undefined) throw new Error(`Unknown FalkorDB ${kind} ID ${id}`);
      return schema[kind][id];
    }
    async function properties(entries) {
      const pairs = [];
      for (const [id, type, value] of entries) {
        pairs.push([await name('properties', id), await decode([type, value])]);
      }
      return Object.fromEntries(pairs);
    }
    async function decode(cell) {
      if (!Array.isArray(cell) || cell.length !== 2) throw new Error('Invalid compact value');
      const [type, value] = cell;
      switch (type) {
        case 1: return null;
        case 2: return value;
        case 3: return value;
        case 4:
          if (value === 'true' || value === 1) return true;
          if (value === 'false' || value === 0) return false;
          throw new Error('Invalid compact boolean');
        case 5: return Number(value);
        case 6: {
          const items = [];
          for (const item of value) items.push(await decode(item));
          return items;
        }
        case 7: return {
          id: value[0], type: await name('relationships', value[1]),
          from: value[2], to: value[3], props: await properties(value[4]),
        };
        case 8: {
          const labels = [];
          for (const id of value[1]) labels.push(await name('labels', id));
          return { id: value[0], labels, props: await properties(value[2]) };
        }
        case 9: return { nodes: await decode(value[0]), edges: await decode(value[1]) };
        case 10: {
          const entries = [];
          for (let i = 0; i < value.length; i += 2) {
            entries.push([value[i], await decode(value[i + 1])]);
          }
          return Object.fromEntries(entries);
        }
        case 11: return { latitude: Number(value[0]), longitude: Number(value[1]) };
        case 12: return value.map(Number);
        default: throw new Error(`Unsupported FalkorDB value type ${type}`);
      }
    }
    const header = result[0].map((column) => column[1]);
    const rows = [];
    for (const row of result[1]) {
      if (row.length !== header.length) throw new Error('FalkorDB row width does not match header');
      const values = [];
      for (const cell of row) values.push(await decode(cell));
      rows.push(values);
    }
    return { header, rows, stats: statistics(result[2]) };
  }

  return {
    async query(graph, cypher, params = {}) {
      validateGraphName(graph);
      const text = parameterized(cypher, params);
      const result = queue.then(async () => {
        if (closed) throw new Error('FalkorDB client is closed');
        return decodeResult(graph, await rawQuery(graph, text));
      });
      // Keep the queue usable after failure; the caller still receives the rejection.
      queue = result.catch(() => {});
      return result;
    },
    async close() {
      closed = true;
      disconnect(new Error('FalkorDB client is closed'));
      await queue;
    },
  };
}
