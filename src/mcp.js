import { findSecret } from "./secret-guard.js";

const VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const KINDS = ["preference", "event", "fact", "decision"];
const MAP_TTL = 5 * 60 * 1_000;
const MAP_WAIT = 800;
const PREPARING_MAP = "Memory map is being prepared — call orient to get it.";
const DEFAULT_INSTRUCTIONS = [
  "Before answering about the user's preferences, past events, plans, or people, inspect the Memory map; open the closest relevant entry once, or skip open if none.",
  "Proactively remember preferences, decisions, events (with an ISO date/time in occurredAt), and facts about the user or their world, even without a request. One fact per call.",
  "Use 3-5 synonymous tags, including Japanese and English for Japanese conversations; use Markdown text and a one-line summary.",
  "Never store passwords, API keys, tokens, card or identity numbers, anything the user says not to remember, small talk, or fleeting details.",
  "After saving, briefly acknowledge it in your reply. Use recall only as a fallback and orient to refresh the map.",
].join("\n");
const nonempty = { type: "string", minLength: 1 };
const externalIdPattern = "^[A-Za-z0-9:_.-]{1,200}$";
const externalReference = {
  type: "string", minLength: 1, maxLength: 200, pattern: externalIdPattern,
};
const datePattern =
  "^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d" +
  "(?:\\.\\d+)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function tools(map) {
  return [
    {
      name: "remember",
      title: "Save a memory",
      description:
        "Proactively call when conversation reveals a preference, decision, event " +
        "(set occurredAt to its ISO date/time), or fact about the user or their world, " +
        "even without a request. One fact per call. Use 3-5 synonymous tags; include " +
        "Japanese and English for Japanese conversations. Use Markdown text and a one-line summary. " +
        "Never store passwords, API keys, tokens, card or identity numbers, anything the user " +
        "says not to remember, small talk, or fleeting details. After saving, briefly " +
        "acknowledge it in your reply (e.g. 'I'll remember that.').",
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      },
      inputSchema: {
        ...schema({
          kind: { type: "string", enum: KINDS },
          title: nonempty,
          text: { type: "string", maxLength: 20_000 },
          summary: { type: "string", pattern: "^[^\\r\\n]*$" },
          tags: { type: "array", items: nonempty, maxItems: 10 },
          occurredAt: { type: "string", format: "date-time", pattern: datePattern },
          relatesTo: { type: "array", items: nonempty },
          externalId: {
            ...externalReference,
            description: "同じ externalId なら置き換える。取り込みツール用で、会話中の AI は普通は使わない。",
          },
          follows: {
            ...externalReference,
            description: "前の記憶の externalId。取り込みツール用で、会話中の AI は普通は使わない。",
          },
        }, ["kind", "title", "text", "summary", "tags"]),
        allOf: [{
          if: { properties: { kind: { const: "event" } }, required: ["kind"] },
          then: { required: ["occurredAt"] },
        }],
      },
    },
    {
      name: "open",
      title: "Open a memory",
      description:
        "Before answering about the user's preferences, past events, plans, or people, " +
        "inspect the Memory map below. If an entry is relevant, open the closest one once " +
        "by title or id. Do not call if the map has no relevant entries. " +
        "Up to 5 nearby memories are included.\n\nMemory map:\n" + map,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        ...schema({ title: nonempty, id: nonempty }),
        anyOf: [{ required: ["title"] }, { required: ["id"] }],
      },
    },
    {
      name: "recall",
      title: "Search memories",
      description:
        "Search as a fallback when the map and open are not enough. Do not call this every time.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: schema({ query: nonempty }, ["query"]),
    },
    {
      name: "orient",
      title: "Refresh the Memory map",
      description: "Refresh the Memory map when you need an up-to-date map. No arguments are needed.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: schema({}),
    },
  ];
}

function invalidArguments(name, args, inputSchema) {
  if (!object(args)) return "Arguments must be an object.";
  if (Object.keys(args).some((key) => !Object.hasOwn(inputSchema.properties, key))) {
    return "Unexpected argument.";
  }
  for (const key of inputSchema.required) {
    if (!Object.hasOwn(args, key)) return `Missing required argument: ${key}.`;
  }
  for (const [key, value] of Object.entries(args)) {
    const definition = inputSchema.properties[key];
    if (definition.type === "string") {
      if (typeof value !== "string") return `${key} must be a string.`;
      if (definition.minLength && !value.trim()) return `${key} must not be empty.`;
      if (definition.maxLength && Array.from(value).length > definition.maxLength) {
        return `${key} must not exceed ${definition.maxLength} characters.`;
      }
    } else if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || !item.trim())
    ) {
      return `${key} must be an array of nonempty strings.`;
    }
  }
  if (name === "remember") {
    if (!KINDS.includes(args.kind)) return "Invalid memory kind.";
    if (args.tags.length > 10) return "tags must contain at most 10 items.";
    if (/[\r\n]/u.test(args.summary)) return "summary must be one line.";
    for (const key of ["externalId", "follows"]) {
      if (args[key] !== undefined && !new RegExp(externalIdPattern, "u").test(args[key])) {
        return `${key} must contain 1-200 letters, digits, colons, underscores, dots or hyphens.`;
      }
    }
    if (args.kind === "event" && args.occurredAt === undefined) {
      return "Events require occurredAt.";
    }
    if (args.occurredAt !== undefined) {
      const value = args.occurredAt;
      const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
      if (
        !new RegExp(datePattern, "u").test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        !Number.isFinite(day.getTime()) ||
        day.toISOString().slice(0, 10) !== value.slice(0, 10)
      ) {
        return "occurredAt must be a valid ISO date and time.";
      }
    }
  }
  if (name === "open" && args.id === undefined && args.title === undefined) {
    return "Provide title or id.";
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: isError ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpHandler({
  memory,
  getUser = (ctx) => ctx.user,
  instructions = DEFAULT_INSTRUCTIONS,
}) {
  if (!memory || typeof getUser !== "function" || typeof instructions !== "string") {
    throw new TypeError("memory, getUser, and string instructions are required");
  }
  const maps = new Map();

  function mapFor(user) {
    if (!maps.has(user)) {
      maps.set(user, { map: undefined, expiresAt: 0, version: 0, pending: undefined });
    }
    return maps.get(user);
  }

  function refreshMap(user, source, entry) {
    entry.source = source;
    if (entry.pending) return entry.pending;
    entry.pending = Promise.resolve().then(async () => {
      for (;;) {
        const version = entry.version;
        try {
          const map = await memory.orient({ user, source: entry.source });
          if (version === entry.version) {
            entry.map = map;
            entry.expiresAt = Date.now() + MAP_TTL;
          }
        } catch {
          console.error("Memory map refresh failed.");
        }
        // A write during the read needs a new map, never the pre-write snapshot.
        if (version === entry.version) break;
      }
    }).finally(() => {
      entry.pending = undefined;
    });
    return entry.pending;
  }

  return async function handle(message, ctx = {}) {
    const hasId = object(message) && Object.hasOwn(message, "id");
    const validId = hasId && (
      message.id === null || typeof message.id === "string" ||
      (typeof message.id === "number" && Number.isFinite(message.id))
    );
    if (
      !object(message) || message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" || (hasId && !validId) ||
      (message.params !== undefined && !object(message.params) && !Array.isArray(message.params))
    ) {
      return rpcError(validId ? message.id : null, -32600, "Invalid Request");
    }
    if (!hasId) return undefined;
    const { id, method } = message;
    if (!["initialize", "ping", "tools/list", "tools/call"].includes(method)) {
      return rpcError(id, -32601, "Method not found");
    }
    const params = message.params ?? {};
    if (!object(params)) return rpcError(id, -32602, "Invalid params");
    if (method === "initialize") {
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: VERSIONS.has(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jinai-memory", version: "0.1.1" },
          instructions,
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    try {
      const user = ctx.user ?? await getUser(ctx);
      if (typeof user !== "string" || !user.trim()) {
        return rpcError(id, -32603, "Memory user is unavailable");
      }
      if (method === "tools/list") {
        const entry = mapFor(user);
        if (Date.now() >= entry.expiresAt) refreshMap(user, ctx.source, entry);
        if (entry.map === undefined && entry.pending) {
          let timeout;
          try {
            await Promise.race([
              entry.pending,
              new Promise((resolve) => { timeout = setTimeout(resolve, MAP_WAIT); }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
        }
        return { jsonrpc: "2.0", id, result: { tools: tools(entry.map ?? PREPARING_MAP) } };
      }
      const tool = tools("").find((entry) => entry.name === params.name);
      if (!tool) return rpcError(id, -32602, "Unknown tool");
      const args = params.arguments === undefined ? {} : params.arguments;
      const problem = invalidArguments(tool.name, args, tool.inputSchema);
      if (problem) return { jsonrpc: "2.0", id, result: toolResult(problem, true) };
      if (tool.name === "remember") {
        const secret = findSecret([args.title, args.text, args.summary, ...args.tags].join("\n"));
        if (secret) {
          return {
            jsonrpc: "2.0", id,
            result: toolResult(
              `This looks like a secret (${secret.kind}). Jin AI Memory does not store secrets.`,
              true,
            ),
          };
        }
      }
      try {
        const result = await memory[tool.name]({ ...args, user, source: ctx.source });
        if (tool.name === "remember") {
          // Unrequested maps stay lazy so writes alone do not emit read notifications.
          const entry = maps.get(user);
          if (entry) {
            entry.version += 1;
            entry.expiresAt = 0;
            refreshMap(user, ctx.source, entry);
          }
        }
        return { jsonrpc: "2.0", id, result: toolResult(result) };
      } catch {
        return { jsonrpc: "2.0", id, result: toolResult("Memory operation failed.", true) };
      }
    } catch {
      return rpcError(id, -32603, "Internal error");
    }
  };
}
