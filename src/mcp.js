const VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const KINDS = ["preference", "event", "fact", "decision"];
const DEFAULT_INSTRUCTIONS =
  "When the user's preferences or past events may matter, first look at the Memory map. " +
  "If needed, call open once. Save new preferences, decisions, and events with remember.";
const nonempty = { type: "string", minLength: 1 };
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
      description:
        "Save a memory. Store preferences as preference and things that happened as event " +
        "with an ISO date and time in occurredAt. Include 3-5 synonymous or related tags " +
        "(for example, dinner, supper, evening meal). Write text in Markdown and summary on one line.",
      inputSchema: {
        ...schema({
          kind: { type: "string", enum: KINDS },
          title: nonempty,
          text: { type: "string", maxLength: 20_000 },
          summary: { type: "string", pattern: "^[^\\r\\n]*$" },
          tags: { type: "array", items: nonempty, maxItems: 10 },
          occurredAt: { type: "string", format: "date-time", pattern: datePattern },
          relatesTo: { type: "array", items: nonempty },
        }, ["kind", "title", "text", "summary", "tags"]),
        allOf: [{
          if: { properties: { kind: { const: "event" } }, required: ["kind"] },
          then: { required: ["occurredAt"] },
        }],
      },
    },
    {
      name: "open",
      description:
        "Open a memory or topic found in the entry map, by title or id. " +
        "Up to 5 nearby memories are included.\n\nMemory map:\n" + map,
      inputSchema: {
        ...schema({ title: nonempty, id: nonempty }),
        anyOf: [{ required: ["title"] }, { required: ["id"] }],
      },
    },
    {
      name: "recall",
      description:
        "Search as a fallback when the map and open are not enough. Do not call this every time.",
      inputSchema: schema({ query: nonempty }, ["query"]),
    },
    {
      name: "orient",
      description: "Return the current memory map. No arguments are needed.",
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
          serverInfo: { name: "jinai-memory", version: "0.1.0" },
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
        let map;
        try {
          map = await memory.orient({ user, source: ctx.source });
        } catch {
          map = "Unavailable. Call orient to retry.";
        }
        return { jsonrpc: "2.0", id, result: { tools: tools(map) } };
      }
      const tool = tools("").find((entry) => entry.name === params.name);
      if (!tool) return rpcError(id, -32602, "Unknown tool");
      const args = params.arguments === undefined ? {} : params.arguments;
      const problem = invalidArguments(tool.name, args, tool.inputSchema);
      if (problem) return { jsonrpc: "2.0", id, result: toolResult(problem, true) };
      try {
        const result = await memory[tool.name]({ ...args, user, source: ctx.source });
        return { jsonrpc: "2.0", id, result: toolResult(result) };
      } catch {
        return { jsonrpc: "2.0", id, result: toolResult("Memory operation failed.", true) };
      }
    } catch {
      return rpcError(id, -32603, "Internal error");
    }
  };
}
