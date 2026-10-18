import assert from "node:assert/strict";
import test from "node:test";
import { createEmbedder } from "../src/embedder.js";
import { createMcpHandler } from "../src/mcp.js";
import { createMemory } from "../src/memory.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const CTX = { user: "alice", source: "claude" };
const NOTE = {
  kind: "preference", title: "ハンバーグが好き", text: "# 好み\nハンバーグが好き",
  summary: "ハンバーグが好き", tags: ["ハンバーグ", "夕飯", "食事"],
};

function setup(t) {
  const store = createMemoryStore();
  t.after(() => store.close());
  const touches = [];
  const memory = createMemory({
    store, embedder: createEmbedder({ provider: "fake", dim: 128 }),
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    onTouch: (event) => touches.push(event),
  });
  const handle = createMcpHandler({ memory });
  const request = (method, params, ctx = CTX) => handle({ jsonrpc: "2.0", id: 1, method, params }, ctx);
  const call = (name, args, ctx) => request("tools/call", { name, arguments: args }, ctx);
  return { store, memory, touches, handle, request, call };
}

function result(reply) {
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.isError, undefined);
  assert.equal(reply.result.content[0].type, "text");
  return JSON.parse(reply.result.content[0].text);
}

test("MCP negotiates all supported protocol versions and falls back for unknown versions", async (t) => {
  const { request } = setup(t);
  for (const protocolVersion of ["2025-06-18", "2025-03-26", "2024-11-05", "future", undefined]) {
    const reply = await request("initialize", { protocolVersion });
    assert.equal(reply.jsonrpc, "2.0");
    assert.equal(reply.id, 1);
    assert.equal(reply.result.protocolVersion, protocolVersion?.startsWith("202") ? protocolVersion : "2025-06-18");
    assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(reply.result.serverInfo, { name: "jinai-memory", version: "0.1.0" });
    assert.match(reply.result.instructions, /Memory map.*open.*remember/su);
    assert.ok(reply.result.instructions.split("\n").length <= 5);
    assert.match(reply.result.instructions, /even without a request/u);
    assert.match(reply.result.instructions, /Never store passwords/u);
  }
  assert.deepEqual((await request("ping")).result, {});
});

test("MCP supports custom instructions and getUser while preferring authenticated context", async (t) => {
  const { memory, store } = setup(t);
  const handle = createMcpHandler({
    memory, getUser: async () => "fallback", instructions: "Use this memory.",
  });
  assert.equal((await handle({ jsonrpc: "2.0", id: "init", method: "initialize" })).result.instructions, "Use this memory.");
  const message = { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "remember", arguments: NOTE } };
  const fallback = result(await handle(message, { source: "chatgpt" }));
  assert.ok(await store.getNode({ user: "fallback", id: fallback.id }));
  const authenticated = result(await handle(message, CTX));
  assert.ok(await store.getNode({ user: "alice", id: authenticated.id }));
});

test("tools/list exposes exactly four schemas and succeeds with an empty graph or empty map", async (t) => {
  const { memory, request } = setup(t);
  const reply = await request("tools/list");
  assert.deepEqual(reply.result.tools.map((tool) => tool.name), ["remember", "open", "recall", "orient"]);
  for (const tool of reply.result.tools) {
    assert.equal(typeof tool.title, "string");
    assert.ok(tool.title.length > 0);
    assert.deepEqual(tool.annotations, tool.name === "remember"
      ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      : { readOnlyHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length <= 600);
  }
  assert.match(reply.result.tools[1].description, /Memory map:/u);
  const remember = reply.result.tools[0];
  assert.ok(remember.inputSchema.required.includes("tags"));
  assert.equal(remember.inputSchema.properties.tags.maxItems, 10);
  assert.equal(remember.inputSchema.properties.text.maxLength, 20_000);
  for (const key of ["externalId", "follows"]) {
    const definition = remember.inputSchema.properties[key];
    assert.equal(definition.type, "string");
    assert.equal(definition.minLength, 1);
    assert.equal(definition.maxLength, 200);
    assert.equal(definition.pattern, "^[A-Za-z0-9:_.-]{1,200}$");
    assert.ok(!remember.inputSchema.required.includes(key));
    assert.match(definition.description, /取り込みツール/u);
  }
  assert.match(remember.description, /preference.*event.*3-5/su);
  assert.match(remember.description, /even without a request/u);
  assert.match(remember.description, /Japanese and English/u);
  assert.match(remember.description, /After saving.*acknowledge/su);
  assert.match(reply.result.tools[1].description, /Before answering.*closest one once/su);
  assert.match(reply.result.tools[1].description, /Do not call if the map has no relevant entries/u);
  const empty = createMcpHandler({ memory: { ...memory, orient: async () => "" } });
  const emptyReply = await empty({ jsonrpc: "2.0", id: 1, method: "tools/list" }, CTX);
  assert.ok(emptyReply.result.tools[1].description.endsWith("Memory map:\n"));
});

test("tools/list rebuilds the map on every call and safely reports map retrieval failures", async (t) => {
  const { memory, call, request } = setup(t);
  const before = (await request("tools/list")).result.tools[1].description;
  await call("remember", NOTE);
  const after = (await request("tools/list")).result.tools[1].description;
  assert.notEqual(after, before);
  assert.match(after, /Memory map:[\s\S]*ハンバーグ/u);
  const broken = createMcpHandler({
    memory: { ...memory, orient: async () => { throw new Error("private backend details"); } },
  });
  const reply = await broken({ jsonrpc: "2.0", id: 1, method: "tools/list" }, CTX);
  assert.equal(reply.result.tools.length, 4);
  assert.match(reply.result.tools[1].description, /Memory map:\nUnavailable/u);
  assert.doesNotMatch(JSON.stringify(reply), /private backend details/u);
});

test("all four tools use the real memory layer and propagate user, source, and related nodes", async (t) => {
  const { store, touches, call } = setup(t);
  const saved = result(await call("remember", NOTE));
  const node = await store.getNode({ user: "alice", id: saved.id });
  assert.equal(node.props.source, "claude");
  assert.equal(node.props.text, NOTE.text);
  assert.equal(await store.getNode({ user: "another", id: saved.id }), null);
  const byId = result(await call("open", { id: saved.id }));
  const byTitle = result(await call("open", { title: NOTE.title }));
  assert.deepEqual(byId, byTitle);
  assert.ok(byId.neighbors.length <= 5);
  const related = result(await call("remember", {
    ...NOTE, kind: "decision", title: "Dinner decision", relatesTo: [saved.id],
  }));
  const edges = await store.neighbors({ user: "alice", id: related.id, types: ["RELATES_TO"] });
  assert.equal(edges[0].node.id, saved.id);
  assert.ok(result(await call("recall", { query: "夕飯" })).preferences.some((item) => item.id === saved.id));
  assert.match(result(await call("orient", {})), /ハンバーグ/u);
  assert.deepEqual(new Set(touches.map((event) => event.op)), new Set(["remember", "open", "recall", "orient"]));
  assert.ok(touches.every((event) => event.source === "claude"));
});

test("orient and tools/list include the caller source in empty and populated map notifications", async (t) => {
  const { call, request, touches } = setup(t);
  for (const populated of [false, true]) {
    if (populated) result(await call("remember", NOTE));
    for (const source of ["claude", "chatgpt"]) {
      touches.length = 0;
      const ctx = { user: "alice", source };
      await request("tools/list", undefined, ctx);
      result(await call("orient", {}, ctx));
      assert.equal(touches.length, 2);
      for (const event of touches) {
        assert.equal(event.op, "orient");
        assert.equal(event.source, source);
        assert.equal(event.user, ctx.user);
        assert.equal(event.nodeIds.length > 0, populated);
      }
    }
  }
});

test("MCP remember returns replacement and follows status through the real memory layer", async (t) => {
  const { call, store, touches } = setup(t);
  const first = result(await call("remember", { ...NOTE, externalId: "cc-session:first" }));
  assert.deepEqual(first, { id: first.id, replaced: false });
  const input = { ...NOTE, externalId: "cc-session:next", follows: "cc-session:first" };
  const next = result(await call("remember", input));
  assert.deepEqual(next, { id: next.id, replaced: false, followsLinked: true });
  const replaced = result(await call("remember", { ...input, text: "updated", tags: ["new"] }));
  assert.deepEqual(replaced, { id: next.id, replaced: true, followsLinked: true });
  assert.equal((await store.getNode({ user: "alice", id: next.id })).props.text, "updated");
  const about = await store.neighbors({ user: "alice", id: next.id, types: ["ABOUT"] });
  assert.deepEqual(about.map(({ node }) => node.props.name), ["new"]);
  const links = await store.neighbors({ user: "alice", id: next.id, types: ["NEXT_STEP"] });
  assert.deepEqual(links.map(({ edge }) => [edge.from, edge.to]), [[first.id, next.id]]);
  assert.ok(touches.at(-1).nodeIds.includes(first.id));
  const missing = result(await call("remember", {
    ...NOTE, externalId: "cc-session:missing", follows: "cc-session:absent",
  }));
  assert.equal(missing.followsLinked, false);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 3);
  const bob = result(await call("remember", input, { user: "bob", source: "claude" }));
  assert.deepEqual(bob, { id: next.id, replaced: false, followsLinked: false });
});

test("MCP secret rejection cannot overwrite an existing externalId or change its edges", async (t) => {
  const { call, store, touches } = setup(t);
  const input = { ...NOTE, externalId: "cc-session:protected" };
  const saved = result(await call("remember", input));
  const nodes = await store.listNodes({ user: "alice" });
  const edges = await store.neighbors({ user: "alice", id: saved.id });
  const count = touches.length;
  const reply = await call("remember", { ...input, text: "password: fake-demo-password", tags: ["new"] });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /does not store secrets/u);
  assert.deepEqual(await store.listNodes({ user: "alice" }), nodes);
  assert.deepEqual(await store.neighbors({ user: "alice", id: saved.id }), edges);
  assert.equal(touches.length, count);
});

test("remember rejects secrets in every stored field without leaking values or changing the graph", async (t) => {
  const { call, store, touches } = setup(t);
  result(await call("remember", NOTE));
  const before = await store.listNodes({ user: "alice" });
  const touchCount = touches.length;
  const secrets = [
    ["api_key", `sk-${"fake".repeat(8)}`],
    ["aws_access_key", `AKIA${"FAKE".repeat(4)}`],
    ["github_token", `ghp_${"fake".repeat(9)}`],
    ["github_token", `github_pat_${"fake".repeat(20)}`],
    ["slack_token", `xoxb-${"fake-".repeat(6)}fake`],
    ["private_key", "-----BEGIN TEST PRIVATE KEY-----"],
    ["password", "password: fake-demo-password"],
    ["card_number", "4111-1111-1111-1111"],
  ];
  for (const [kind, value] of secrets) {
    for (const field of ["title", "text", "summary", "tags"]) {
      const reply = await call("remember", { ...NOTE, [field]: field === "tags" ? [value] : value });
      assert.equal(reply.error, undefined);
      assert.equal(reply.result.isError, true);
      assert.equal(reply.result.content[0].text,
        `This looks like a secret (${kind}). Jin AI Memory does not store secrets.`);
      assert.ok(!JSON.stringify(reply).includes(value));
      assert.deepEqual(await store.listNodes({ user: "alice" }), before);
      assert.equal(touches.length, touchCount);
    }
  }
});

test("remember accepts ordinary preferences, phone numbers, dates, prices, and password changes without values", async (t) => {
  const { call, store } = setup(t);
  for (const text of [
    "ハンバーグが好き", "電話は 03-1234-5678", "2026-10-17", "価格は 1,980 円",
    "パスワードを変えた（値なし）",
  ]) {
    result(await call("remember", { ...NOTE, text }));
  }
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 5);
});

test("cross-client dinner flow returns yesterday's event with days_ago 1", async (t) => {
  const { call, request } = setup(t);
  const ctx = { user: "alice", source: "chatgpt" };
  const preference = result(await call("remember", NOTE, ctx));
  const event = result(await call("remember", {
    ...NOTE, kind: "event", title: "昨日の夕飯",
    text: "昨日の夕飯にハンバーグを食べた", summary: "夕飯にハンバーグを食べた",
    occurredAt: "2026-10-15T12:00:00.000Z",
  }, ctx));
  assert.match((await request("tools/list")).result.tools[1].description, /Memory map:[\s\S]*ハンバーグ/u);
  const recalled = result(await call("recall", { query: "今日の夕飯、何がいい？" }));
  assert.equal(recalled.preferences.find((item) => item.id === preference.id)?.source, "chatgpt");
  assert.equal(recalled.recent_events.find((item) => item.id === event.id)?.days_ago, 1);
});

test("tool argument validation rejects bad types, missing values, limits, dates, and context injection", async (t) => {
  const { call, store } = setup(t);
  const invalid = [
    ["remember", null],
    ["remember", []],
    ["remember", {}],
    ...["kind", "title", "text", "summary", "tags"].map((key) => {
      const args = { ...NOTE };
      delete args[key];
      return ["remember", args];
    }),
    ["remember", { ...NOTE, kind: "unknown" }],
    ["remember", { ...NOTE, title: " " }],
    ["remember", { ...NOTE, title: 1 }],
    ["remember", { ...NOTE, text: false }],
    ["remember", { ...NOTE, text: "x".repeat(20_001) }],
    ["remember", { ...NOTE, summary: "two\nlines" }],
    ["remember", { ...NOTE, summary: null }],
    ["remember", { ...NOTE, tags: "food" }],
    ["remember", { ...NOTE, tags: Array(11).fill("tag") }],
    ["remember", { ...NOTE, tags: [1] }],
    ["remember", { ...NOTE, tags: [" "] }],
    ["remember", { ...NOTE, relatesTo: [false] }],
    ...["externalId", "follows"].flatMap((key) =>
      ["", " ", "bad/id", "bad\n", "bad\r\n", "日本語", "a".repeat(201), null, 1, [], {}]
        .map((value) => ["remember", { ...NOTE, [key]: value }])),
    ["remember", { ...NOTE, user: "another" }],
    ["remember", { ...NOTE, source: "spoofed" }],
    ["remember", { ...NOTE, kind: "event" }],
    ...["yesterday", "2026-02-30T12:00:00Z", "2026-10-15", "2026-10-15T25:00:00Z", 1].map(
      (occurredAt) => ["remember", { ...NOTE, kind: "event", occurredAt }],
    ),
    ["open", {}],
    ["open", { title: "" }],
    ["open", { id: false }],
    ["recall", {}],
    ["recall", { query: " " }],
    ["recall", { query: 1 }],
    ["orient", { extra: true }],
    ["orient", null],
  ];
  for (const [name, args] of invalid) {
    const reply = await call(name, args);
    assert.equal(reply.result?.isError, true, `${name}: ${JSON.stringify(args).slice(0, 120)}`);
    assert.equal(typeof reply.result.content[0].text, "string");
  }
  assert.deepEqual(await store.listNodes({ user: "alice" }), []);
});

test("remember accepts exact size limits, all kinds, and ISO timezone offsets", async (t) => {
  const { call, store } = setup(t);
  for (const kind of ["preference", "event", "fact", "decision"]) {
    const saved = result(await call("remember", {
      ...NOTE, kind, text: "x".repeat(20_000), tags: Array.from({ length: 10 }, (_, i) => `tag-${i}`),
      occurredAt: "2026-10-15T21:00:00+09:00",
    }));
    assert.equal((await store.getNode({ user: "alice", id: saved.id })).props.text.length, 20_000);
  }
  const saved = result(await call("remember", {
    ...NOTE, externalId: "A0:_.-".padEnd(200, "x"), follows: "a".repeat(200),
  }));
  assert.equal(saved.replaced, false);
  assert.equal(saved.followsLinked, false);
});

test("memory operation errors are tool errors without backend messages or stack traces", async (t) => {
  const { memory, call } = setup(t);
  assert.equal((await call("open", { title: "not present" })).result.isError, true);
  const handle = createMcpHandler({
    memory: { ...memory, remember: async () => { throw new Error("private backend details"); } },
  });
  const reply = await handle({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: NOTE },
  }, CTX);
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, "Memory operation failed.");
  assert.doesNotMatch(JSON.stringify(reply), /private backend details|stack/u);
});

test("MCP distinguishes invalid requests, unknown methods, unknown tools, and notifications", async (t) => {
  const { handle, request, touches } = setup(t);
  for (const message of [
    null, [], "request", {}, { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: {}, method: "ping" },
    { jsonrpc: "2.0", id: 1, method: 1 },
    { jsonrpc: "2.0", id: 1, method: "ping", params: false },
  ]) {
    assert.equal((await handle(message, CTX)).error.code, -32600);
  }
  assert.equal((await request("unknown")).error.code, -32601);
  assert.equal((await request("unknown", [])).error.code, -32601);
  assert.equal((await request("tools/call", { name: "unknown" })).error.code, -32602);
  assert.equal((await request("tools/list", [])).error.code, -32602);
  for (const method of ["notifications/initialized", "notifications/cancelled", "unknown"]) {
    assert.equal(await handle({ jsonrpc: "2.0", method }, CTX), undefined);
  }
  assert.deepEqual(touches, []);
  assert.equal((await handle({ jsonrpc: "2.0", id: null, method: "ping" }, CTX)).id, null);
});
