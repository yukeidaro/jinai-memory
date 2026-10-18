import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  discoverTranscripts, formatTranscriptList, main, parseOptions, parseTranscriptState,
  planTranscripts, readTranscript, sendTranscripts,
} from "../scripts/import-transcripts.mjs";
import { createEmbedder } from "../src/embedder.js";
import { createEventHub } from "../src/events.js";
import { importEndpoint } from "../src/importer.js";
import { createMemory } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const ROOT = fileURLToPath(new URL("./fixtures/transcripts/", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/import-transcripts.mjs", import.meta.url));
const TOKEN = "fictional-transcript-token+/=";
const options = () => parseOptions(["--root", ROOT]);
const extracted = async () => {
  const result = [];
  for (const filename of await discoverTranscripts(ROOT)) result.push(await readTranscript(filename));
  return result;
};
const plan = async () => planTranscripts(await extracted(), options());

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "transcripts-fictional-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function setup(t, legacy = false) {
  const store = createMemoryStore();
  const hub = createEventHub();
  const memory = createMemory({ store, embedder: createEmbedder({ provider: "fake", dim: 16 }) });
  const calls = [];
  const external = new Map();
  const server = legacy
    ? createServer({ memory, store, hub, token: TOKEN, user: "fictional" })
    : createHttpServer(async (req, res) => {
      assert.equal(req.url, `/mcp/${encodeURIComponent(TOKEN)}-claude-code`);
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      const { externalId, follows, ...args } = request.params.arguments;
      calls.push(request.params.arguments);
      assert.ok(externalId.startsWith("cc-session:"));
      const previous = external.get(externalId);
      let id;
      if (previous) {
        id = previous;
        await store.upsertNode({
          user: "fictional", id, labels: ["Memory"],
          props: { title: args.title, text: args.text, summary: args.summary, occurredAt: args.occurredAt },
        });
      } else {
        ({ id } = await memory.remember({ ...args, user: "fictional", source: "claude-code" }));
        external.set(externalId, id);
      }
      const target = follows && external.get(follows);
      if (target) await store.addEdge({ user: "fictional", from: target, to: id, type: "NEXT_STEP" });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: request.id, result: {
          content: [{ type: "text", text: JSON.stringify({
            id, replaced: Boolean(previous), followsLinked: Boolean(target),
          }) }],
        },
      }));
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    store, base, calls, external,
    env: { JINAI_MEMORY_URL: base, JINAI_MEMORY_TOKEN: TOKEN },
    memories: () => store.listNodes({ user: "fictional", label: "Memory" }),
  };
}

test("transcript discovery recursively excludes scratch projects and repeated custom exclusions", async () => {
  const files = await discoverTranscripts(ROOT);
  assert.equal(files.length, 6);
  assert.ok(files.every((filename) => !filename.includes("scratch-workspaces")));
  const settings = parseOptions([
    "--root", ROOT.replaceAll("\\", "/"), "--exclude-project", "orbit", "--exclude-project", "unused",
  ]);
  assert.equal(settings.root, path.resolve(ROOT));
  assert.equal((await discoverTranscripts(settings.root, settings.exclude)).length, 3);
  assert.equal((await plan()).filter((entry) => entry.status === "skipped").length, 1);
});

test("transcript plans sort globally by time and chain only sessions of the same canonical project", async () => {
  const entries = (await plan()).filter((entry) => entry.transcript);
  assert.deepEqual(entries.map((entry) => entry.transcript.sessionId),
    ["orbit-one", "kiln-one", "orbit-two", "orbit-three", "kiln-two"]);
  assert.deepEqual(entries.map((entry) => entry.memory.follows),
    [undefined, undefined, "cc-session:orbit-one", "cc-session:orbit-two", "cc-session:kiln-one"]);
  assert.ok(entries.every((entry) => entry.memory.externalId === `cc-session:${entry.transcript.sessionId}`));
  const source = await extracted();
  assert.deepEqual(planTranscripts(source, { ...options(), since: "2026-10-16", limit: 2 })
    .map((entry) => entry.transcript.sessionId), ["orbit-two", "orbit-three"]);
  assert.deepEqual(planTranscripts(source, { ...options(), session: "kiln-two" })
    .map((entry) => entry.transcript.sessionId), ["kiln-two"]);
  assert.equal(planTranscripts(source, { ...options(), session: "missing" }).length, 0);
});

test("default dry run sends nothing, writes no state, and only displays the prescribed metadata columns", async (t) => {
  const directory = await temporary(t);
  const state = path.join(directory, "no-write", "state.json");
  const output = [];
  let calls = 0;
  assert.deepEqual(await main(["--root", ROOT, "--state", state], {
    env: {}, log: (line) => output.push(line),
    fetchImpl: () => { calls += 1; throw new Error("Must not send."); },
  }), { success: 0, failed: 0, replaced: 0, skipped: 6 });
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []);
  const text = output.join("\n");
  assert.match(text, /status\s+\| date\s+\| project\s+\| title\s+\| files \| dropped/u);
  assert.match(text, /Total: 6; new=5, changed=0, unchanged=0, skipped=1; dropped=1/u);
  assert.match(text, /rerun with --yes/u);
  for (const omitted of [
    "Keep the map compact", "Injected private", "fictional-value", "scratch project",
    "src/map.js", ROOT, "FICTIONAL_", "https://github.com/",
  ]) assert.ok(!text.includes(omitted), omitted);
});

test("--yes imports into a fictional T16-compatible memory-store server, replaces changed sessions and skips unchanged", async (t) => {
  const { env, calls, memories, store, external } = await setup(t);
  const directory = await temporary(t);
  const root = path.join(directory, "transcripts");
  await cp(ROOT, root, { recursive: true });
  const state = path.join(directory, "state.json");
  const args = ["--root", root, "--state", state];
  const dry = await cli(args, env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(calls.length, 0);
  assert.equal((await memories()).length, 0);
  const first = await cli([...args, "--yes"], env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /success=5, failed=0, replaced=0, skipped=1/u);
  assert.equal((await memories()).length, 5);
  assert.deepEqual(calls.map((call) => call.externalId),
    ["cc-session:orbit-one", "cc-session:kiln-one", "cc-session:orbit-two", "cc-session:orbit-three", "cc-session:kiln-two"]);
  const nextEdges = [];
  for (const node of await memories()) {
    for (const { edge } of await store.neighbors({ user: "fictional", id: node.id, types: ["NEXT_STEP"] })) {
      if (edge.from === node.id) nextEdges.push(edge);
    }
  }
  assert.equal(nextEdges.length, 3);
  assert.ok(nextEdges.some((edge) => edge.from === external.get("cc-session:orbit-one") &&
    edge.to === external.get("cc-session:orbit-two")));
  for (const name of ["orbit", "map.js", "map-review"]) {
    const [topic] = await store.findNodes({ user: "fictional", label: "Topic", where: { name } });
    assert.ok(topic);
    assert.ok((await store.neighbors({ user: "fictional", id: topic.id, types: ["ABOUT"] })).length >= 2);
  }
  assert.equal((await store.listNodes({ user: "another-fictional", label: "Memory" })).length, 0);
  const saved = parseTranscriptState(await readFile(state, "utf8"));
  assert.equal(Object.keys(saved).length, 5);
  assert.ok(Object.values(saved).every((entry) => entry.mtimeMs > 0 && entry.size > 0 && entry.hash.length === 64));
  assert.ok(!JSON.stringify(saved).includes("Fictional"));
  const again = await cli([...args, "--yes"], env);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /unchanged=5/u);
  assert.match(again.stdout, /success=0, failed=0, replaced=0, skipped=6/u);
  assert.equal(calls.length, 5);
  await appendFile(path.join(root, "C--Fictional-orbit", "a-second.jsonl"),
    '\n{"type":"custom-title","customTitle":"Refine the fictional labels"}\n');
  const changed = await cli(args, env);
  assert.equal(changed.code, 0, changed.stderr);
  assert.match(changed.stdout, /changed=1, unchanged=4/u);
  const replacement = await cli([...args, "--yes"], env);
  assert.equal(replacement.code, 0, replacement.stderr);
  assert.match(replacement.stdout, /success=1, failed=0, replaced=1, skipped=5/u);
  assert.equal((await memories()).length, 5);
  assert.equal((await memories()).find((node) => node.id === external.get("cc-session:orbit-two"))
    .props.title, "Refine the fictional labels");
  assert.ok(!calls.some((call) => JSON.stringify(call).includes("fictional-value")));
});

test("--yes imports three sessions through createServer, skips unchanged and replaces after state loss", async (t) => {
  const { env, memories, store } = await setup(t, true);
  const directory = await temporary(t);
  const state = path.join(directory, "state.json");
  const args = ["--root", path.join(ROOT, "C--Fictional-orbit"), "--state", state, "--yes"];
  const requests = [];
  const saved = [];
  const output = [];
  const dependencies = {
    env, log: (line) => output.push(line),
    fetchImpl: async (url, settings) => {
      requests.push(JSON.parse(settings.body).params.arguments);
      const response = await fetch(url, settings);
      const reply = await response.clone().json();
      saved.push(JSON.parse(reply.result.content[0].text));
      return response;
    },
  };
  assert.deepEqual(await main(args, dependencies), { success: 3, failed: 0, replaced: 0, skipped: 0 });
  assert.deepEqual(requests.map(({ follows }) => follows),
    [undefined, "cc-session:orbit-one", "cc-session:orbit-two"]);
  assert.equal(Object.hasOwn(saved[0], "followsLinked"), false);
  assert.deepEqual(saved.slice(1).map(({ followsLinked }) => followsLinked), [true, true]);
  const original = await memories();
  assert.equal(original.length, 3);
  const nextSteps = async () => {
    const edges = [];
    for (const node of await memories()) {
      for (const { edge } of await store.neighbors({ user: "fictional", id: node.id, types: ["NEXT_STEP"] })) {
        if (edge.from === node.id) edges.push([edge.from, edge.to]);
      }
    }
    return edges.sort();
  };
  const ids = new Map(original.map((node) => [node.props.externalId, node.id]));
  const expectedEdges = [
    [ids.get("cc-session:orbit-one"), ids.get("cc-session:orbit-two")],
    [ids.get("cc-session:orbit-two"), ids.get("cc-session:orbit-three")],
  ].sort();
  assert.deepEqual(await nextSteps(), expectedEdges);
  output.length = 0;
  assert.deepEqual(await main(args, dependencies), { success: 0, failed: 0, replaced: 0, skipped: 3 });
  assert.match(output.join("\n"), /unchanged=3/u);
  assert.equal(requests.length, 3);
  await rm(state);
  assert.deepEqual(await main(args, dependencies), { success: 3, failed: 0, replaced: 3, skipped: 0 });
  assert.ok(saved.slice(3).every((reply) => reply.replaced === true));
  assert.equal((await memories()).length, 3);
  assert.deepEqual((await memories()).map((node) => node.id).sort(), original.map((node) => node.id).sort());
  assert.deepEqual(await nextSteps(), expectedEdges);
  assert.equal(Object.keys(parseTranscriptState(await readFile(state, "utf8"))).length, 3);
});

test("--no-external-id works against the current createServer and real memory layer without changing the server", async (t) => {
  const { base, env, memories } = await setup(t, true);
  const directory = await temporary(t);
  const output = [];
  const result = await main([
    "--root", ROOT, "--state", path.join(directory, "legacy.json"), "--session", "orbit-two",
    "--yes", "--server", base, "--no-external-id",
  ], { env: { ...env, JINAI_MEMORY_URL: "not a URL" }, log: (line) => output.push(line) });
  assert.deepEqual(result, { success: 1, failed: 0, replaced: 0, skipped: 0 });
  assert.match(output.join("\n"), /Legacy mode/u);
  assert.equal((await memories()).length, 1);
  assert.equal((await memories())[0].props.source, "claude-code");
  assert.ok(!output.join("\n").includes(TOKEN));
});

test("session and since filters retain already imported predecessors outside the selection", async (t) => {
  const { env, calls } = await setup(t);
  const directory = await temporary(t);
  const args = ["--root", ROOT, "--state", path.join(directory, "state.json"), "--yes"];
  await main([...args, "--session", "orbit-one"], { env, log: () => {} });
  await main([...args, "--session", "orbit-two"], { env, log: () => {} });
  assert.equal(calls[1].follows, "cc-session:orbit-one");
  await main([...args, "--since", "2026-10-17", "--limit", "1"], { env, log: () => {} });
  assert.equal(calls[2].follows, "cc-session:orbit-two");
});

test("imports are sequential, continue after failures, and never point later sessions at unsaved predecessors", async () => {
  const entries = await plan();
  const state = {};
  const snapshots = [];
  const output = [];
  const bodies = [];
  let active = 0;
  let maximum = 0;
  const result = await sendTranscripts(entries, {
    endpoint: importEndpoint("http://127.0.0.1", TOKEN, "claude-code"),
    state, persist: async (next) => snapshots.push(structuredClone(next)),
    log: (line) => output.push(line),
    fetchImpl: async (url, settings) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        assert.equal(settings.redirect, "error");
        const { id, params } = JSON.parse(settings.body);
        bodies.push(params.arguments);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (bodies.length === 1) throw new Error(`DO_NOT_PRINT ${TOKEN}`);
        return Response.json({ jsonrpc: "2.0", id, result: { content: [{
          type: "text", text: JSON.stringify({ id: `fictional-${id}`, replaced: false, followsLinked: Boolean(params.arguments.follows) }),
        }] } });
      } finally {
        active -= 1;
      }
    },
  });
  assert.equal(maximum, 1);
  assert.deepEqual(result, { success: 4, failed: 1, replaced: 0, skipped: 1 });
  assert.equal(bodies[2].externalId, "cc-session:orbit-two");
  assert.equal(bodies[2].follows, undefined);
  assert.equal(bodies[3].follows, "cc-session:orbit-two");
  assert.equal(snapshots.length, 4);
  assert.ok(!Object.hasOwn(state, "orbit-one"));
  assert.ok(!output.join("\n").includes(TOKEN));
  assert.ok(!output.join("\n").includes("DO_NOT_PRINT"));
});

test("HTTP, JSON-RPC, tool and link errors stay private and never update successful-only state", async () => {
  const [entry] = await plan();
  const responses = [
    () => new Response(TOKEN, { status: 503 }),
    () => new Response(TOKEN),
    (id) => Response.json({ jsonrpc: "2.0", id, error: { message: TOKEN } }),
    (id) => Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: TOKEN }] } }),
    (id) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: '{"id":"legacy"}' }] } }),
    (id) => Response.json({ jsonrpc: "2.0", id: id + 1, result: {} }),
  ];
  const output = [];
  for (const response of responses) {
    const state = {};
    const result = await sendTranscripts([entry], {
      endpoint: new URL("http://127.0.0.1"), state, persist: () => assert.fail("Must not save"),
      log: (line) => output.push(line),
      fetchImpl: async (url, settings) => response(JSON.parse(settings.body).id),
    });
    assert.equal(result.failed, 1);
    assert.deepEqual(state, {});
  }
  assert.ok(!output.join("\n").includes(TOKEN));
  const orbitTwo = (await plan()).find((item) => item.transcript?.sessionId === "orbit-two");
  const predecessorState = {
    "orbit-one": {
      projectKey: entry.transcript.projectKey, occurredAt: entry.transcript.occurredAt, externalIds: true,
    },
  };
  for (const followsLinked of [undefined, null, "true", false]) {
    const unlinked = await sendTranscripts([orbitTwo], {
      state: predecessorState, persist: () => assert.fail("Unconfirmed links must not update state"),
      log: (line) => output.push(line),
      fetchImpl: async (url, settings) => {
        const request = JSON.parse(settings.body);
        assert.equal(request.params.arguments.follows, "cc-session:orbit-one");
        return Response.json({
          jsonrpc: "2.0", id: request.id, result: { content: [{
            type: "text", text: JSON.stringify({ id: "fictional", replaced: false, followsLinked }),
          }] },
        });
      },
    });
    assert.deepEqual(unlinked, { success: 0, failed: 1, replaced: 0, skipped: 0 });
    assert.ok(!Object.hasOwn(predecessorState, "orbit-two"));
    assert.match(output.at(-1), followsLinked === false
      ? /NEXT_STEP link was not confirmed/u : /unsupported remember result/u);
  }
  assert.match(output.join("\n"), /NEXT_STEP link was not confirmed/u);
  const unsafe = structuredClone(entry);
  unsafe.transcript.memory.title = "password: fictional-not-sent";
  const result = await sendTranscripts([unsafe], {
    state: {}, persist: () => assert.fail("Must not save"), log: () => {},
    fetchImpl: () => assert.fail("Must not send"),
  });

  test("transcripts modified during streaming are visibly skipped, and raw read errors never reach CLI output", async (t) => {
    const directory = await temporary(t);
    const filename = path.join(directory, "unstable.jsonl");
    await writeFile(filename, '{"type":"user","timestamp":"2026-10-18T00:00:00Z","message":{"content":"Safe fictional task."}}\n');
    const altered = await readTranscript(filename, {
      openStream: (name, settings) => Readable.from((async function* () {
        yield* createReadStream(name, settings);
        await appendFile(name, "\n");
      })(), { objectMode: false }),
    });
    assert.equal(altered.reason, "modified-during-read");
    assert.equal(altered.transcript, null);
    const rows = planTranscripts([altered], options());
    assert.equal(rows[0].status, "skipped");
    assert.match(formatTranscriptList(rows), /modified-during-read/u);
    const failed = await cli(["--root", ROOT, "--state", directory]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Could not read transcript state/u);
    assert.ok(!failed.stderr.includes(directory));
    assert.ok(!failed.stderr.includes("EISDIR"));
  });
  assert.equal(result.skipped, 1);
  await assert.rejects(sendTranscripts([entry, entry], {
    state: {}, persist: () => { throw new Error(TOKEN); }, log: () => {},
    fetchImpl: async (url, settings) => Response.json({
      jsonrpc: "2.0", id: JSON.parse(settings.body).id, result: { content: [{
        type: "text", text: '{"id":"fictional","replaced":false,"followsLinked":false}',
      }] },
    }),
  }), /state could not be written/u);
});

test("10,000 fictional records are consumed with createReadStream/readline, not whole-file reads", async (t) => {
  const directory = await temporary(t);
  const filename = path.join(directory, "large.jsonl");
  const first = JSON.stringify({
    type: "user", sessionId: "fictional-large", timestamp: "2026-10-18T00:00:00Z",
    cwd: "/fictional/large", message: { content: "Count the tool calls." },
  });
  const record = JSON.stringify({
    type: "assistant", timestamp: "2026-10-18T00:01:00Z",
    message: { content: [
      { type: "text", text: "IGNORED_FICTIONAL_AI_BODY".repeat(40) },
      { type: "tool_use", name: "Read", input: { file_path: "/fictional/large/file.js" } },
    ] },
  });
  await writeFile(filename, `${first}\n${`${record}\n`.repeat(9_999)}`);
  let streamCalls = 0;
  let bytes = 0;
  let maximumChunk = 0;
  const result = await readTranscript(filename, {
    openStream: (name, settings) => {
      streamCalls += 1;
      assert.equal(settings.highWaterMark, 64 * 1024);
      const stream = createReadStream(name, settings);
      stream.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        maximumChunk = Math.max(maximumChunk, Buffer.byteLength(chunk));
      });
      return stream;
    },
  });
  assert.equal(streamCalls, 1);
  assert.ok(bytes > 8 * 1024 * 1024);
  assert.ok(maximumChunk <= 64 * 1024);
  assert.equal(result.transcript.scale.toolCalls, 9_999);
  assert.ok(result.transcript.memory.text.length < 1_000);
  assert.ok(!result.transcript.memory.text.includes("IGNORED_FICTIONAL"));
  const source = await readFile(CLI, "utf8");
  const streamingFunction = source.slice(source.indexOf("export async function readTranscript"), source.indexOf("export function parseTranscriptState"));
  assert.match(streamingFunction, /for await \(const line of lines\)/u);
  assert.ok(!streamingFunction.includes("readFile("));
  assert.ok(!streamingFunction.includes("lines.push("));
});

test("token arguments, invalid filters, corrupt state and unsafe server URLs fail without echoing values", async (t) => {
  for (const args of [["--token", TOKEN], [`--token=${TOKEN}`], [TOKEN]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: {}, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tokens must only be set in JINAI_MEMORY_TOKEN/u);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(TOKEN));
  }
  for (const args of [
    ["--since", "2026-02-30"], ["--since", "invalid"], ["--limit", "0"],
    ["--limit", "-1"], ["--limit", "2.5"], ["--session", "../private"],
    ["--exclude-project", ""],
  ]) assert.throws(() => parseOptions(args));
  const directory = await temporary(t);
  const state = path.join(directory, "broken.json");
  await writeFile(state, `{"secret":"${TOKEN}"`);
  await assert.rejects(main(["--root", ROOT, "--state", state], { env: {}, log: () => {} }), /not valid JSON/u);
  for (const text of ["null", "[]", '{"version":1,"entries":{"bad":{}}}']) {
    assert.throws(() => parseTranscriptState(text), /unsupported format/u);
  }
  await assert.rejects(main(["--root", ROOT, "--yes", "--server", "http://127.0.0.1"], {
    env: {}, log: () => {},
  }), /JINAI_MEMORY_TOKEN is required/u);
  for (const base of ["file:///fictional", "https://private:password@localhost", "http://localhost/?secret=yes"]) {
    assert.throws(() => importEndpoint(base, TOKEN, "claude-code"));
  }
  assert.deepEqual(await discoverTranscripts(path.join(directory, "missing")), []);
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /metadata-only dry run/u);
  assert.equal(formatTranscriptList([]).split("\n").length, 1);
});

test("ignored AI-only file changes stay unchanged and newly added sessions repair the next session's follows", async (t) => {
  const { env, calls } = await setup(t);
  const directory = await temporary(t);
  const root = path.join(directory, "root");
  await mkdir(root);
  const record = (id, timestamp) => JSON.stringify({
    type: "user", sessionId: id, timestamp, cwd: "/fictional/shared", message: { content: "A safe fictional task." },
  });
  await writeFile(path.join(root, "first.jsonl"), record("first", "2026-10-15T00:00:00Z"));
  await writeFile(path.join(root, "third.jsonl"), record("third", "2026-10-17T00:00:00Z"));
  const args = ["--root", root, "--state", path.join(directory, "state.json")];
  await main([...args, "--yes"], { env, log: () => {} });
  await appendFile(path.join(root, "first.jsonl"), '\n{"type":"assistant","message":{"content":"Ignored fictional answer."}}\n');
  const logs = [];
  await main(args, { env, log: (line) => logs.push(line) });
  assert.match(logs.join("\n"), /unchanged=2/u);
  await writeFile(path.join(root, "second.jsonl"), record("second", "2026-10-16T00:00:00Z"));
  assert.deepEqual(await main([...args, "--yes"], { env, log: () => {} }),
    { success: 2, failed: 0, replaced: 1, skipped: 1 });
  assert.equal(calls.at(-1).externalId, "cc-session:third");
  assert.equal(calls.at(-1).follows, "cc-session:second");
});
