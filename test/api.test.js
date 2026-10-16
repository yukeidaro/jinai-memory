import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { createEmbedder } from "../src/embedder.js";
import { createEventHub } from "../src/events.js";
import { createMemory } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store/memory-store.js";

async function setup(t) {
  const store = createMemoryStore();
  const token = randomUUID();
  const touches = [];
  const memory = createMemory({
    store, embedder: createEmbedder({ provider: "fake", dim: 128 }),
    onTouch: (event) => touches.push(event),
  });
  const server = createServer({ memory, store, hub: createEventHub(), token, user: "demo" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const graph = () => fetch(`${base}/api/graph?token=${encodeURIComponent(token)}`);
  return { store, memory, token, touches, base, graph };
}

test("GET /api/graph returns the documented empty JSON snapshot with CORS", async (t) => {
  const { graph } = await setup(t);
  const before = Date.now();
  const response = await graph();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const snapshot = await response.json();
  assert.deepEqual(Object.keys(snapshot).sort(), ["generatedAt", "links", "nodes", "user"]);
  assert.deepEqual({ ...snapshot, generatedAt: null }, { user: "demo", generatedAt: null, nodes: [], links: [] });
  assert.ok(Date.parse(snapshot.generatedAt) >= before && Date.parse(snapshot.generatedAt) <= Date.now());
});

test("GET /api/graph exposes MCP writes from all four sources without extra memory touches", async (t) => {
  const { base, token, graph, touches } = await setup(t);
  for (const source of ["chatgpt", "claude", "cursor", "copilot"]) {
    const response = await fetch(`${base}/mcp/${token}-${source}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "remember", arguments: {
          kind: "fact", title: `note ${source}`, text: "# Markdown",
          summary: "summary", tags: ["shared", "topic", "notes"],
        } },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.isError, undefined);
  }
  const snapshot = await (await graph()).json();
  assert.equal(snapshot.nodes.length, 11);
  assert.equal(snapshot.nodes.filter((node) => node.type === "memory").length, 4);
  assert.deepEqual(new Set(snapshot.nodes.filter((node) => node.type === "source").map((node) => node.label)),
    new Set(["chatgpt", "claude", "cursor", "copilot"]));
  assert.equal(touches.length, 4);
  assert.ok(snapshot.nodes.filter((node) => node.type === "memory").every((node) =>
    node.text === "# Markdown" && node.tags.length === 3));
  assert.ok(snapshot.links.filter((link) => link.type === "MENTIONED_BY").every((link) => link.w === 1));
  assert.equal(new Set(snapshot.links.map((link) =>
    JSON.stringify([link.source, link.target, link.type]))).size, snapshot.links.length);
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  assert.ok(snapshot.links.every((link) => ids.has(link.source) && ids.has(link.target)));
});

test("graph rejects missing, empty, incorrect, and different-byte-length tokens with 404 and CORS", async (t) => {
  const { base } = await setup(t);
  for (const suffix of ["", "?token=", `?token=${randomUUID()}`, "?token=wrong", "?token=%E3%81%82"]) {
    const response = await fetch(`${base}/api/graph${suffix}`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
});

test("graph authenticates before rejecting non-GET methods with Allow GET", async (t) => {
  const { base, token } = await setup(t);
  for (const method of ["POST", "OPTIONS", "HEAD"]) {
    const response = await fetch(`${base}/api/graph?token=${encodeURIComponent(token)}`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    await response.text();
    const hidden = await fetch(`${base}/api/graph`, { method });
    assert.equal(hidden.status, 404);
    await hidden.text();
  }
});

test("graph surfaces backend failures as JSON 500 with CORS, not a success-shaped empty graph", async (t) => {
  const { store, graph } = await setup(t);
  await store.close();
  const response = await graph();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), { error: "Internal server error" });
});

const seed = path.resolve("scripts", "seed-demo.mjs");

test("seed --dry-run prints ten fictional payloads, all sources, tags, and yesterday at local noon without secrets", () => {
  const token = randomUUID();
  const before = new Date();
  const result = spawnSync(process.execPath, [seed, "http://127.0.0.1:1", token, "--dry-run"], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stdout.includes("http://"), false);
  const notes = JSON.parse(result.stdout);
  assert.equal(notes.length, 10);
  assert.deepEqual(new Set(notes.map((note) => note.source)), new Set(["chatgpt", "claude", "cursor", "copilot"]));
  assert.ok(notes.every((note) => note.arguments.tags.length >= 3 && note.arguments.tags.length <= 5));
  assert.ok(notes.every((note) => !/[\r\n]/u.test(note.arguments.summary)));
  assert.equal(notes.filter((note) => note.source !== "chatgpt").length, 8);
  const event = notes.find((note) => note.arguments.title === "夕飯にハンバーグを食べた");
  assert.equal(event.source, "chatgpt");
  const noon = new Date(event.arguments.occurredAt);
  assert.equal(noon.getHours(), 12);
  assert.equal(noon.getMinutes(), 0);
  assert.equal(noon.getSeconds(), 0);
  assert.equal(noon.getMilliseconds(), 0);
  const expected = [before, new Date()].map((date) => {
    date.setDate(date.getDate() - 1);
    date.setHours(12, 0, 0, 0);
    return date.toISOString();
  });
  assert.ok(expected.includes(event.arguments.occurredAt));
  assert.match(event.arguments.text, /## 材料[\s\S]*## 作り方/u);
  assert.equal(notes.some((note) => note.arguments.title.includes("焼き魚")), false);
  assert.ok(notes.some((note) => note.source === "cursor" && note.arguments.title === "献立アプリの設計メモ"));
  assert.ok(notes.some((note) => note.source === "copilot" && note.arguments.title === "買い物リストのスクリプト"));
});

async function runSeed(t, base, token) {
  const child = spawn(process.execPath, [seed, base, token], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("seed writes through real MCP HTTP into the graph with all four tool sources", { timeout: 15_000 }, async (t) => {
  const { base, token, graph } = await setup(t);
  const result = await runSeed(t, base, token);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Seeded 10 demo memories/u);
  assert.equal(result.stdout.includes(token), false);
  const snapshot = await (await graph()).json();
  const memories = snapshot.nodes.filter((node) => node.type === "memory");
  assert.equal(memories.length, 10);
  const counts = Object.fromEntries(["chatgpt", "claude", "cursor", "copilot"].map((source) =>
    [source, memories.filter((node) => node.source === source).length]));
  assert.deepEqual(counts, { chatgpt: 2, claude: 4, cursor: 2, copilot: 2 });
  assert.ok(memories.every((node) => node.tags.length >= 3 && node.tags.length <= 5));
  const event = memories.find((node) => node.label === "夕飯にハンバーグを食べた");
  assert.equal(event.kind, "event");
  assert.match(event.text, /## 材料[\s\S]*## 作り方/u);
  assert.equal(new Set(snapshot.nodes.filter((node) => node.type === "source").map((node) => node.label)).size, 4);
});

test("seed fails explicitly on HTTP errors without printing the token, URL, or server body", { timeout: 5_000 }, async (t) => {
  const { base } = await setup(t);
  const wrong = randomUUID();
  const result = await runSeed(t, base, wrong);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /HTTP 404/u);
  assert.equal(result.stderr.includes(wrong), false);
  assert.equal(result.stderr.includes(base), false);
});
