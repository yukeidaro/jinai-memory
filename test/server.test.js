import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmbedder } from "../src/embedder.js";
import { createEventHub } from "../src/events.js";
import { createMemory } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const NOTE = {
  kind: "preference", title: "ハンバーグが好き", text: "ハンバーグが好き",
  summary: "ハンバーグが好き", tags: ["ハンバーグ", "夕飯", "食事"],
};

async function setup(t, options = {}) {
  const store = createMemoryStore();
  const hub = createEventHub();
  const touches = [];
  const token = options.token ?? options.users?.[0]?.token ?? randomUUID();
  const memory = createMemory({
    store, embedder: createEmbedder({ provider: "fake", dim: 128 }),
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    onTouch(event) { touches.push(event); hub.publish(event); },
  });
  const server = createServer({ memory, store, hub, token, user: "alice", ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (credential = token) => {
    const url = (source = "claude") => `${base}/mcp/${encodeURIComponent(credential)}-${source}`;
    const post = (body, source = "claude", headers = { "Content-Type": "application/json" }) =>
      fetch(url(source), { method: "POST", headers, body: JSON.stringify(body) });
    const request = async (method, params, source = "claude") => {
      const response = await post({ jsonrpc: "2.0", id: 1, method, params }, source);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/json");
      return response.json();
    };
    const call = (name, args, source) => request("tools/call", { name, arguments: args }, source);
    return { url, post, request, call };
  };
  return { store, memory, server, hub, touches, token, base, client, ...client() };
}

function value(reply) {
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.isError, undefined);
  return JSON.parse(reply.result.content[0].text);
}

function rawRequest(server, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: server.address().port,
      path: pathname, method: body === undefined ? "GET" : "POST", headers,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("HTTP initialize, tools/list, remember, open, recall, and orient share the real graph", async (t) => {
  const { request, call } = await setup(t);
  assert.equal((await request("initialize", { protocolVersion: "2025-06-18" })).result.protocolVersion, "2025-06-18");
  assert.equal((await request("tools/list")).result.tools.length, 4);
  const saved = value(await call("remember", NOTE));
  assert.equal(value(await call("open", { id: saved.id })).note.text, NOTE.text);
  assert.equal(value(await call("recall", { query: "夕飯" })).preferences[0].id, saved.id);
  assert.match(value(await call("orient", {})), /ハンバーグ/u);
});

test("HTTP hides invalid tokens and sources and returns Allow POST for authenticated GET", async (t) => {
  const { base, token, url, server } = await setup(t);
  const wrong = await fetch(`${base}/mcp/${randomUUID()}-claude`);
  assert.equal(wrong.status, 404);
  await wrong.text();
  for (const source of ["Claude", "has_space ", "a".repeat(21), "bad/source", "bad\\source", "bad:source", ""]) {
    const response = await fetch(`${base}/mcp/${token}-${encodeURIComponent(source)}`);
    assert.equal(response.status, 404);
    await response.text();
  }
  assert.equal((await rawRequest(server, `/mcp/${token}-bad%`)).status, 404);
  for (const source of ["claude", "chatgpt", "cursor", "copilot", "custom-agent", "a".repeat(20)]) {
    const response = await fetch(url(source));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    await response.text();
  }
});

test("separate Claude and ChatGPT URLs set both saved Memory source and onTouch source", async (t) => {
  const { call, store, touches } = await setup(t);
  for (const source of ["claude", "chatgpt"]) {
    const saved = value(await call("remember", { ...NOTE, title: `${NOTE.title} ${source}` }, source));
    const node = await store.getNode({ user: "alice", id: saved.id });
    assert.equal(node.props.source, source);
    assert.ok(touches.some((event) =>
      event.op === "remember" && event.source === source && event.nodeIds.includes(saved.id)));
  }
  assert.equal((await store.listNodes({ user: "alice", label: "Source" })).length, 2);
});

test("HTTP dinner flow writes through ChatGPT and exposes map and yesterday's event through Claude", async (t) => {
  const { call, request } = await setup(t);
  const preference = value(await call("remember", NOTE, "chatgpt"));
  const event = value(await call("remember", {
    ...NOTE, kind: "event", title: "昨日の夕飯", text: "夕飯にハンバーグを食べた",
    summary: "夕飯にハンバーグを食べた", occurredAt: "2026-10-15T12:00:00.000Z",
  }, "chatgpt"));
  const list = await request("tools/list", {}, "claude");
  assert.match(list.result.tools.find((tool) => tool.name === "open").description, /Memory map:[\s\S]*ハンバーグ/u);
  const recalled = value(await call("recall", { query: "今日の夕飯、何がいい？" }, "claude"));
  assert.equal(recalled.preferences.find((item) => item.id === preference.id)?.source, "chatgpt");
  const yesterday = recalled.recent_events.find((item) => item.id === event.id);
  assert.equal(yesterday.days_ago, 1);
  assert.equal(yesterday.source, "chatgpt");
});

test("SSE delivers the full remember event with nodeIds within one second of the call", { timeout: 5_000 }, async (t) => {
  const { base, token, call, hub, touches } = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/events?token=${encodeURIComponent(token)}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/u);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(hub.size(), 1);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /: connected\n\n/u);
  const eventPromise = (async () => {
    let text = "";
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { event: JSON.parse(text.slice("data: ".length).trim()), received: performance.now() };
  })();
  const started = performance.now();
  const saved = value(await call("remember", NOTE, "chatgpt"));
  const { event, received } = await eventPromise;
  const elapsed = received - started;
  assert.ok(elapsed >= 0 && elapsed < 1_000, `SSE delivery took ${elapsed.toFixed(1)}ms`);
  t.diagnostic(`remember -> SSE: ${elapsed.toFixed(1)}ms (< 1000ms)`);
  assert.ok(event.nodeIds.includes(saved.id));
  assert.equal(event.user, "alice");
  assert.equal(event.source, "chatgpt");
  assert.equal(event.op, "remember");
  assert.equal(event.at, "2026-10-16T12:00:00.000Z");
  assert.deepEqual(event, touches[0]);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.size(), 0);
});

test("SSE rejects missing and incorrect tokens", async (t) => {
  const { base } = await setup(t);
  for (const suffix of ["", `?token=${randomUUID()}`]) {
    const response = await fetch(`${base}/events${suffix}`);
    assert.equal(response.status, 404);
    await response.text();
  }
});

test("SSE flushes events larger than the socket high-water mark before closing", { timeout: 5_000 }, async (t) => {
  const { base, token, hub } = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/events?token=${encodeURIComponent(token)}`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  const event = {
    user: "alice", op: "recall", source: "claude",
    nodeIds: Array.from({ length: 4_000 }, () => randomUUID()), at: "2026-10-16T12:00:00.000Z",
  };
  hub.publish(event);
  const decoder = new TextDecoder();
  let text = "";
  while (!text.endsWith("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.deepEqual(JSON.parse(text.slice("data: ".length).trim()), event);
  await reader.cancel();
});

test("HTTP handles notifications, mixed batches, invalid JSON-RPC, and parse errors", async (t) => {
  const { post, request, url } = await setup(t);
  for (const message of [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    [{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", method: "notifications/cancelled" }],
  ]) {
    const response = await post(message);
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  }
  const mixed = await post([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 0, method: "ping" },
    { jsonrpc: "2.0", id: "missing", method: "unknown" },
  ]);
  const replies = await mixed.json();
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[0], { jsonrpc: "2.0", id: 0, result: {} });
  assert.equal(replies[1].error.code, -32601);
  for (const invalid of [[], null, { method: "ping", id: 1 }]) {
    assert.equal((await (await post(invalid)).json()).error.code, -32600);
  }
  const malformed = await fetch(url(), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, -32700);
  assert.equal((await request("tools/call", { name: "unknown" })).error.code, -32602);
});

test("HTTP batches preserve remember-before-map ordering", async (t) => {
  const { post } = await setup(t);
  const response = await post([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: NOTE } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const replies = await response.json();
  assert.ok(value(replies[0]).id);
  assert.match(replies[1].result.tools[1].description, /Memory map:[\s\S]*ハンバーグ/u);
});

test("HTTP requires JSON content type and accepts charset parameters", async (t) => {
  const { post } = await setup(t);
  const message = { jsonrpc: "2.0", id: 1, method: "ping" };
  for (const headers of [{}, { "Content-Type": "text/plain" }]) {
    const response = await post(message, "claude", headers);
    assert.equal(response.status, 415);
    await response.text();
  }
  const response = await post(message, "claude", { "Content-Type": "application/json; charset=utf-8" });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, {});
});

test("HTTP enforces the 1 MiB byte limit for content-length and chunked bodies", async (t) => {
  const { url, server, token } = await setup(t);
  const response = await fetch(url(), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1_048_577),
  });
  assert.equal(response.status, 413);
  await response.text();
  const chunked = await rawRequest(server, `/mcp/${token}-claude`, "x".repeat(1_048_577), {
    "Content-Type": "application/json", "Transfer-Encoding": "chunked",
  });
  assert.equal(chunked.status, 413);
  const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const boundary = await fetch(url(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: message + " ".repeat(1_048_576 - Buffer.byteLength(message)),
  });
  assert.equal(boundary.status, 200);
  assert.deepEqual((await boundary.json()).result, {});
});

test("HTTP serves health and static files and rejects raw and encoded traversal", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t2-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, "public");
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, "index.html"), "<h1>Memory</h1>");
  await writeFile(path.join(publicDir, "app.js"), "export const ready = true;");
  await writeFile(path.join(directory, "outside.txt"), "not public");
  const { base, server } = await setup(t, { publicDir });
  const health = await fetch(`${base}/healthz`);
  assert.deepEqual(await health.json(), { ok: true });
  const index = await fetch(`${base}/`);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await index.text(), "<h1>Memory</h1>");
  const script = await fetch(`${base}/app.js`);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(await script.text(), /ready/u);
  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  await missing.text();
  for (const pathname of [
    "/../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt",
    "/%2e%2e%5coutside.txt", "/app.js::$DATA", "/%00", "/bad%",
  ]) {
    const response = await rawRequest(server, pathname);
    assert.ok([400, 403].includes(response.status));
    assert.doesNotMatch(response.text, /not public/u);
  }
});

test("HTTP starts when publicDir is absent and never starts without a token", async (t) => {
  const { base, memory, hub } = await setup(t, { publicDir: path.join(os.tmpdir(), randomUUID()) });
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 404);
  await response.text();
  assert.throws(() => createServer({ memory, hub }), /token/u);
  assert.throws(() => createServer({ memory, hub, token: "" }), /token/u);
});

test("CLI refuses to start without MEMORY_TOKEN and explains how to configure it", () => {
  const child = spawnSync(process.execPath, [path.resolve("src", "server.js")], {
    env: { SystemRoot: process.env.SystemRoot }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.match(child.stderr, /MEMORY_TOKEN is required/u);
  assert.match(child.stderr, /\$env:MEMORY_TOKEN=/u);
});

test("two tokens isolate remember, recall, open, maps, and graph snapshots", async (t) => {
  const users = [{ user: "demo", token: randomUUID() }, { user: "yu", token: randomUUID() }];
  const { base, client } = await setup(t, { users, token: "ignored-legacy-token", user: "ignored" });
  const demo = client(users[0].token);
  const yu = client(users[1].token);
  const graph = async (token) => {
    const response = await fetch(`${base}/api/graph?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const demoNote = { ...NOTE, title: "Demo dinner", text: "Demo only", summary: "Demo only" };
  const yuNote = { ...NOTE, title: "Yu dinner", text: "Yu only", summary: "Yu only" };
  const savedDemo = value(await demo.call("remember", demoNote));
  assert.deepEqual(value(await yu.call("recall", { query: NOTE.title })).preferences, []);
  assert.deepEqual((await graph(users[1].token)).nodes, []);
  const savedYu = value(await yu.call("remember", yuNote, "chatgpt"));
  for (const [account, own, other, ownNote, otherNote] of [
    [users[0], savedDemo, savedYu, demoNote, yuNote],
    [users[1], savedYu, savedDemo, yuNote, demoNote],
  ]) {
    const connection = client(account.token);
    const recalled = value(await connection.call("recall", { query: NOTE.title }));
    assert.deepEqual(recalled.preferences.map(({ id }) => id), [own.id]);
    assert.equal(value(await connection.call("open", { id: own.id })).note.title, ownNote.title);
    assert.equal((await connection.call("open", { id: other.id })).result.isError, true);
    assert.equal((await connection.call("open", { title: otherNote.title })).result.isError, true);
    for (const reply of [
      await connection.request("tools/list"),
      await connection.call("orient", {}),
    ]) {
      assert.equal(JSON.stringify(reply).includes(otherNote.summary), false);
    }
    const snapshot = await graph(account.token);
    assert.equal(snapshot.user, account.user);
    assert.deepEqual(snapshot.nodes.filter(({ type }) => type === "memory").map(({ id }) => id), [own.id]);
    assert.equal(snapshot.nodes.some(({ id }) => id === other.id), false);
    assert.equal(JSON.stringify(snapshot).includes(otherNote.summary), false);
  }
});

test("HTTP SSE never sends the other token's remember or recall notifications", { timeout: 5_000 }, async (t) => {
  const users = [{ user: "demo", token: randomUUID() }, { user: "yu", token: randomUUID() }];
  const { base, client } = await setup(t, { users });
  const readers = [];
  for (const { token } of users) {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${base}/events?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /: connected\n\n/u);
    readers.push(reader);
  }
  const yu = value(await client(users[1].token).call("remember", NOTE));
  value(await client(users[1].token).call("recall", { query: NOTE.title }));
  const demo = value(await client(users[0].token).call("remember", NOTE));
  const events = await Promise.all(readers.map(async (reader) => {
    let text = "";
    const decoder = new TextDecoder();
    while (!text.endsWith("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text.trim().split("\n\n").map((frame) => JSON.parse(frame.slice("data: ".length)));
  }));
  for (const [index, saved] of [demo, yu].entries()) {
    assert.ok(events[index].length > 0);
    assert.ok(events[index].every((event) => event.user === users[index].user));
    assert.ok(events[index].some((event) => event.op === "remember" && event.nodeIds.includes(saved.id)));
  }
  await Promise.all(readers.map((reader) => reader.cancel()));
});

test("multi-user MCP, graph, and SSE hide missing, invalid, and ignored legacy tokens with 404", async (t) => {
  const users = [{ user: "demo", token: randomUUID() }, { user: "yu", token: randomUUID() }];
  const legacy = randomUUID();
  const { base } = await setup(t, { users, token: legacy });
  for (const token of ["", "x", randomUUID(), legacy, users[0].token + "x", users[1].token.slice(1), "あ".repeat(36)]) {
    for (const route of [
      `/mcp/${encodeURIComponent(token)}-claude`,
      `/api/graph?token=${encodeURIComponent(token)}`,
      `/events?token=${encodeURIComponent(token)}`,
    ]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Not found" });
    }
  }
  for (const route of ["/api/graph", "/events"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404);
    await response.text();
  }
});

test("encoded tokens containing Base64 and percent characters work for MCP, graph, and SSE", async (t) => {
  const users = [
    { user: "demo", token: "demo+/-=%2F".repeat(3) },
    { user: "yu", token: "yu+/-=%2F".repeat(4) },
  ];
  const { base, client } = await setup(t, { users });
  for (const { user, token } of users) {
    const saved = value(await client(token).call("remember", NOTE, "custom-agent"));
    const snapshot = await (await fetch(`${base}/api/graph?token=${encodeURIComponent(token)}`)).json();
    assert.equal(snapshot.user, user);
    assert.deepEqual(snapshot.nodes.filter(({ type }) => type === "memory").map(({ id }) => id), [saved.id]);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${base}/events?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    assert.equal(response.status, 200);
    await response.body.cancel();
  }
});

test("MCP selects the longest matching token independently of users ordering", async (t) => {
  const token = "shared-prefix-aaaaaaaaaaaaaaaaaaaaaaaa";
  const short = { user: "demo", token };
  const long = { user: "yu", token: `${token}-custom` };
  for (const users of [[short, long], [long, short]]) {
    const { client, store } = await setup(t, { users });
    const saved = value(await client(long.token).call("remember", NOTE, "agent"));
    assert.equal((await store.getNode({ user: "yu", id: saved.id })).props.source, "agent");
    assert.equal(await store.getNode({ user: "demo", id: saved.id }), null);
    value(await client(short.token).call("remember", NOTE, "claude"));
    assert.equal((await store.listNodes({ user: "demo", label: "Memory" })).length, 1);
  }
});

test("legacy short token and custom user namespace still support MCP and graph", async (t) => {
  const { base, token, call } = await setup(t, { token: "legacy-token", user: "legacy:user" });
  const saved = value(await call("remember", NOTE));
  const response = await fetch(`${base}/api/graph?token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.user, "legacy:user");
  assert.deepEqual(snapshot.nodes.filter(({ type }) => type === "memory").map(({ id }) => id), [saved.id]);
});

test("createServer rejects empty user lists, invalid entries, and duplicate tokens", async (t) => {
  const { memory, store, hub } = await setup(t);
  for (const users of [
    [], null, {}, [null], [{ user: "demo", token: "" }], [{ user: "", token: randomUUID() }],
    [{ user: "demo", token: "same-token" }, { user: "yu", token: "same-token" }],
  ]) {
    assert.throws(() => createServer({ memory, store, hub, users, token: randomUUID() }), TypeError);
  }
});

test("CLI rejects invalid MEMORY_USERS explicitly without printing supplied tokens", () => {
  const token = randomUUID();
  for (const MEMORY_USERS of [
    `{"demo":"${token}"`,
    JSON.stringify({ "bad/name": token }),
    JSON.stringify({ demo: token, yu: token }),
    JSON.stringify({ demo: token.slice(0, 23) }),
  ]) {
    const child = spawnSync(process.execPath, [path.resolve("src", "server.js")], {
      env: { SystemRoot: process.env.SystemRoot, MEMORY_USERS }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /MEMORY_USERS/u);
    assert.equal(child.stderr.includes(token), false);
    assert.equal(child.stderr.includes(token.slice(0, 23)), false);
  }
});

test("HTTP rejects a directory symlink that escapes publicDir", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t2-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, "public");
  const outsideDir = path.join(directory, "outside");
  await mkdir(publicDir);
  await mkdir(outsideDir);
  await writeFile(path.join(outsideDir, "note.txt"), "not public");
  await symlink(outsideDir, path.join(publicDir, "escape"), "junction");
  const { base } = await setup(t, { publicDir });
  const response = await fetch(`${base}/escape/note.txt`);
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /not public/u);
});

function fakeResponse() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (chunk) => { res.chunks.push(chunk); return !res.blocked; };
  res.end = () => { res.ended = true; res.emit("close"); };
  res.destroy = () => { res.destroyed = true; res.emit("close"); };
  return res;
}

test("SSE hub isolates users, emits 15-second heartbeats, and unsubscribes on close or error", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const hub = createEventHub();
  const alice = fakeResponse();
  const bob = fakeResponse();
  hub.subscribe(alice, { user: "alice" });
  hub.subscribe(bob, { user: "bob" });
  assert.equal(hub.size(), 2);
  assert.deepEqual(alice.chunks, [": connected\n\n"]);
  const event = { user: "alice", source: "claude", op: "open", nodeIds: ["node"], at: "2026-10-16T12:00:00Z" };
  hub.publish(event);
  assert.equal(alice.chunks[1], `data: ${JSON.stringify(event)}\n\n`);
  assert.equal(bob.chunks.length, 1);
  t.mock.timers.tick(14_999);
  assert.equal(bob.chunks.length, 1);
  t.mock.timers.tick(1);
  assert.equal(bob.chunks[1], ": ping\n\n");
  alice.emit("close");
  bob.emit("error", new Error("disconnected"));
  assert.equal(hub.size(), 0);
  t.mock.timers.tick(30_000);
  assert.equal(bob.chunks.length, 2);
});

test("SSE hub caps active subscribers at 50 and removes backpressured readers", () => {
  const hub = createEventHub();
  const responses = Array.from({ length: 50 }, () => fakeResponse());
  for (const res of responses) hub.subscribe(res, { user: "alice" });
  try {
    assert.equal(hub.size(), 50);
    const excess = fakeResponse();
    hub.subscribe(excess, { user: "alice" });
    assert.equal(excess.status, 503);
    assert.equal(excess.headers["Access-Control-Allow-Origin"], "*");
    assert.equal(hub.size(), 50);
    responses[0].blocked = true;
    hub.publish({ user: "alice", op: "remember", nodeIds: [] });
    assert.equal(responses[0].ended, true);
    assert.equal(hub.size(), 49);
    const replacement = fakeResponse();
    hub.subscribe(replacement, { user: "alice" });
    assert.equal(replacement.status, 200);
    replacement.emit("close");
  } finally {
    for (const res of responses) res.emit("close");
  }
  assert.equal(hub.size(), 0);
});
