import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main, parseOptions } from "../scripts/import.mjs";
import {
  discoverTranscripts, parseOptions as transcriptOptions, planTranscripts, readTranscript,
} from "../scripts/import-transcripts.mjs";
import { createEmbedder } from "../src/embedder.js";
import { createEventHub } from "../src/events.js";
import { createMemory } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const HOME = fileURLToPath(new URL("./fixtures/import-home/", import.meta.url));
const ROOT = fileURLToPath(new URL("./fixtures/transcripts/", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/import.mjs", import.meta.url));
const TOKEN = "fictional-combined-token+/=";
const labels = ["skills", "memory files", "CLAUDE.md sections", "Claude Code sessions", "secrets skipped"];

function summary(output, counts, failures = {}) {
  const lines = output.trimEnd().split("\n").slice(-5);
  assert.equal(lines.length, 5);
  for (const [index, label] of labels.entries()) {
    const marker = failures[label] ? `✗ \\(${failures[label]} failed\\)` : "✓";
    assert.match(lines[index], new RegExp(`^${label.replaceAll(".", "\\.")}\\s+${counts[index]} ${marker}$`, "u"));
  }
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "import-all-fictional-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function homeWithSessions(t) {
  const home = path.join(await temporary(t), "home");
  await cp(HOME, home, { recursive: true });
  const root = path.join(home, ".claude", "projects");
  await cp(ROOT, root, { recursive: true });
  return { home, root };
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

async function setup(t, { failTitles = [], realServer = false } = {}) {
  const store = createMemoryStore();
  const memory = createMemory({ store, embedder: createEmbedder({ provider: "fake", dim: 16 }) });
  const calls = [];
  const external = new Map();
  const server = realServer
    ? createServer({ memory, store, hub: createEventHub(), token: TOKEN, user: "fictional" })
    : createHttpServer(async (req, res) => {
    assert.equal(req.url, `/mcp/${encodeURIComponent(TOKEN)}-claude-code`);
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const { externalId, follows, ...args } = request.params.arguments;
    calls.push(request.params.arguments);
    res.setHeader("Content-Type", "application/json");
    if (failTitles.includes(args.title)) {
      res.writeHead(503).end(`PRIVATE_FICTIONAL_BODY ${TOKEN}`);
      return;
    }
    const { id } = await memory.remember({ ...args, user: "fictional", source: "claude-code" });
    if (externalId) external.set(externalId, id);
    const previous = follows && external.get(follows);
    if (previous) await store.addEdge({ user: "fictional", from: previous, to: id, type: "NEXT_STEP" });
    res.end(JSON.stringify({
      jsonrpc: "2.0", id: request.id, result: { content: [{
        type: "text", text: JSON.stringify({ id, replaced: false, followsLinked: Boolean(previous) }),
      }] },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  });
  return {
    calls, store, memory,
    env: { JINAI_MEMORY_URL: `http://127.0.0.1:${server.address().port}`, JINAI_MEMORY_TOKEN: TOKEN },
    memories: () => store.listNodes({ user: "fictional", label: "Memory" }),
  };
}

test("combined dry run ends with five exact counts and makes no requests or state writes", async (t) => {
  const home = await temporary(t);
  const output = [];
  const result = await main(["--home", HOME, "--root", ROOT], {
    env: {}, home, log: (line) => output.push(line),
    fetchImpl: () => assert.fail("Dry run must not send"),
  });
  assert.deepEqual(result, { success: 0, failed: 0, skipped: 15 });
  summary(output.join("\n"), [2, 5, 2, 5, 1]);
  assert.match(output.join("\n"), /Dry run: nothing sent/u);
  for (const omitted of ["paper-folding", "Build the orbit map", "Use a square sheet", "fictional-value", HOME, ROOT]) {
    assert.ok(!output.join("\n").includes(omitted), omitted);
  }
  const isolated = await homeWithSessions(t);
  const run = await cli(["--home", isolated.home]);
  assert.equal(run.code, 0, run.stderr);
  summary(run.stdout, [2, 5, 2, 5, 1]);
  await assert.rejects(readFile(path.join(isolated.home, ".jinai-memory", "import-state.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(isolated.home, ".jinai-memory", "transcript-state.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(home), []);
});

test("--verbose shows metadata from both importers without bodies or summaries", async () => {
  const result = await cli(["--home", HOME, "--root", ROOT, "--verbose"]);
  assert.equal(result.code, 0, result.stderr);
  summary(result.stdout, [2, 5, 2, 5, 1]);
  assert.match(result.stdout, /paper-folding/u);
  assert.match(result.stdout, /Build the orbit map/u);
  assert.match(result.stdout, /status\s+\| kind/u);
  assert.match(result.stdout, /status\s+\| date/u);
  for (const omitted of ["Use a square sheet", "Keep the map compact", "fictional-value", "FICTIONAL_"]) {
    assert.ok(!result.stdout.includes(omitted), omitted);
  }
});

test("--yes sends both categories to a local T16-compatible server and reuses both state files", async (t) => {
  const { home, root } = await homeWithSessions(t);
  const { env, calls, memories, store } = await setup(t);
  const args = ["--home", home, "--yes"];
  const first = await cli(args, env);
  assert.equal(first.code, 0, first.stderr);
  summary(first.stdout, [2, 5, 2, 5, 1]);
  assert.match(first.stdout, /success=14, failed=0, skipped=1/u);
  assert.equal((await memories()).length, 14);
  assert.ok(calls.slice(0, 9).every((call) => call.externalId === undefined));
  assert.deepEqual(calls.slice(9).map((call) => call.externalId),
    ["cc-session:orbit-one", "cc-session:kiln-one", "cc-session:orbit-two", "cc-session:orbit-three", "cc-session:kiln-two"]);
  assert.equal(calls[11].follows, "cc-session:orbit-one");
  assert.equal((await store.listNodes({ user: "another-fictional", label: "Memory" })).length, 0);
  for (const [name, count] of [["import-state.json", 9], ["transcript-state.json", 5]]) {
    const text = await readFile(path.join(home, ".jinai-memory", name), "utf8");
    assert.equal(Object.keys(JSON.parse(text).entries).length, count);
    assert.ok(!text.includes("Use a square sheet"));
    assert.ok(!text.includes(TOKEN));
  }
  const again = await cli(args, env);
  assert.equal(again.code, 0, again.stderr);
  summary(again.stdout, [2, 5, 2, 5, 1]);
  assert.match(again.stdout, /success=0, failed=0, skipped=15/u);
  assert.equal(calls.length, 14);
  await appendFile(path.join(home, ".claude", "skills", "paper-folding", "SKILL.md"), "\nA revised fictional step.\n");
  await appendFile(path.join(root, "C--Fictional-orbit", "a-second.jsonl"),
    '\n{"type":"custom-title","customTitle":"A revised fictional session"}\n');
  const changed = await cli(args, env);
  assert.equal(changed.code, 0, changed.stderr);
  summary(changed.stdout, [2, 5, 2, 5, 1]);
  assert.match(changed.stdout, /success=2, failed=0, skipped=13/u);
  assert.equal(calls.length, 16);
});

test("combined --yes imports three sessions through createServer and replaces safely after state loss", async (t) => {
  const home = await temporary(t);
  const { env, memories, store, memory } = await setup(t, { realServer: true });
  const remember = memory.remember;
  const saved = [];
  t.mock.method(memory, "remember", async (args) => {
    const reply = await remember(args);
    saved.push(reply);
    return reply;
  });
  const args = ["--home", home, "--root", path.join(ROOT, "C--Fictional-orbit"), "--yes", "--verbose"];
  const first = await cli(args, env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /success=3, failed=0, skipped=0/u);
  summary(first.stdout, [0, 0, 0, 3, 1]);
  assert.equal(Object.hasOwn(saved[0], "followsLinked"), false);
  assert.deepEqual(saved.map(({ replaced }) => replaced), [false, false, false]);
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
  const again = await cli(args, env);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /success=0, failed=0, skipped=3/u);
  assert.equal(again.stdout.match(/unchanged/gu)?.length, 3);
  assert.equal(saved.length, 3);
  const state = path.join(home, ".jinai-memory", "transcript-state.json");
  await rm(state);
  const replay = await cli(args, env);
  assert.equal(replay.code, 0, replay.stderr);
  assert.match(replay.stdout, /success=3, failed=0, skipped=0/u);
  assert.equal(saved.length, 6);
  assert.ok(saved.slice(3).every((reply) => reply.replaced === true));
  assert.equal((await memories()).length, 3);
  assert.deepEqual((await memories()).map((node) => node.id).sort(), original.map((node) => node.id).sort());
  assert.deepEqual(await nextSteps(), expectedEdges);
  assert.equal(Object.keys(JSON.parse(await readFile(state, "utf8")).entries).length, 3);
});

test("combined filters apply to sessions, repeated includes become instruction sections, and --server wins", async (t) => {
  const { home } = await homeWithSessions(t);
  const { env, calls } = await setup(t);
  const result = await cli([
    "--home", home, "--root", ROOT, "--since", "2026-10-16", "--limit", "1",
    "--exclude-project", "kiln", "--exclude-project", "unused",
    "--include", path.join(home, "extra.md"), "--include", path.join(home, "extra.md"),
    "--server", env.JINAI_MEMORY_URL, "--yes",
  ], { ...env, JINAI_MEMORY_URL: "not a server URL" });
  assert.equal(result.code, 0, result.stderr);
  summary(result.stdout, [2, 5, 4, 1, 0]);
  assert.equal(calls.length, 12);
  assert.equal(calls.at(-1).externalId, "cc-session:orbit-two");
  const parsed = parseOptions(["--home", home]);
  assert.equal(parsed.transcripts.root, path.join(home, ".claude", "projects"));
  assert.equal(parsed.transcripts.state, path.join(home, ".jinai-memory", "transcript-state.json"));
});

test("dated scratch cwd basenames and scratch-workspaces directories are excluded in both import paths", async (t) => {
  const root = await temporary(t);
  const record = (id, cwd) => JSON.stringify({
    type: "user", sessionId: id, cwd, timestamp: "2026-10-18T00:00:00Z",
    message: { content: "A fictional scratch-exclusion check." },
  });
  for (const [id, cwd] of [
    ["scratch-windows", "C:\\Fictional\\scratch-2026-09-27-07d701\\"],
    ["scratch-posix", "/fictional/SCRATCH-2026-09-27-07D701/"],
    ["keep", "C:\\Fictional\\scratch-2026-09-27-07d701-not-temporary"],
  ]) await writeFile(path.join(root, `${id}.jsonl`), record(id, cwd));
  const scratchDirectory = path.join(root, "C--Fictional-SCRATCH-WORKSPACES-hidden");
  await mkdir(scratchDirectory);
  await writeFile(path.join(scratchDirectory, "hidden.jsonl"), record("hidden", "C:\\Fictional\\other"));
  const files = await discoverTranscripts(root);
  assert.equal(files.length, 3);
  const extracted = [];
  for (const filename of files) extracted.push(await readTranscript(filename));
  const entries = planTranscripts(extracted, transcriptOptions(["--root", root]));
  assert.deepEqual(entries.map((entry) => entry.transcript.sessionId), ["keep"]);
  const result = await cli(["--home", HOME, "--root", root, "--verbose"]);
  assert.equal(result.code, 0, result.stderr);
  summary(result.stdout, [2, 5, 2, 1, 0]);
  assert.ok(!result.stdout.includes("scratch-windows"));
  assert.ok(!result.stdout.includes("scratch-posix"));
});

test("secret counts cover skipped files and dropped transcript items without sending them", async (t) => {
  const { home } = await homeWithSessions(t);
  const unsafe = path.join(home, "fictional-secret.md");
  const fake = `ghp_${"fictional".repeat(4)}`;
  await writeFile(unsafe, `## Safe\nFictional instructions.\n## Unsafe\n${fake}`);
  const { env, calls } = await setup(t);
  const result = await cli(["--home", home, "--include", unsafe, "--yes"], env);
  assert.equal(result.code, 0, result.stderr);
  summary(result.stdout, [2, 5, 3, 5, 2]);
  assert.ok(!JSON.stringify(calls).includes(fake));
  assert.ok(!JSON.stringify(calls).includes("fictional-value"));
  assert.ok(!result.stdout.includes(fake));
});

test("failed sends mark the affected categories, exit nonzero, continue, and never print server contents", async (t) => {
  const { home } = await homeWithSessions(t);
  const { env, calls } = await setup(t, { failTitles: ["paper-folding", "Build the orbit map"] });
  const result = await cli(["--home", home, "--yes"], env);
  assert.equal(result.code, 1, result.stderr);
  summary(result.stdout, [2, 5, 2, 5, 1], { skills: 1, "Claude Code sessions": 1 });
  assert.match(result.stdout, /success=12, failed=2, skipped=1/u);
  assert.equal(calls.length, 14);
  assert.equal(calls[11].follows, undefined);
  assert.ok(!result.stdout.includes(TOKEN));
  assert.ok(!result.stdout.includes("PRIVATE_FICTIONAL_BODY"));
  const local = JSON.parse(await readFile(path.join(home, ".jinai-memory", "import-state.json"), "utf8"));
  const sessions = JSON.parse(await readFile(path.join(home, ".jinai-memory", "transcript-state.json"), "utf8"));
  assert.equal(Object.keys(local.entries).length, 8);
  assert.equal(Object.keys(sessions.entries).length, 4);
});

test("token arguments, invalid filters and missing environment tokens fail safely before scanning", async () => {
  for (const args of [["--token", TOKEN], [`--token=${TOKEN}`], [TOKEN]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: {}, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Tokens must only be set in JINAI_MEMORY_TOKEN/u);
    assert.ok(!result.stderr.includes(TOKEN));
  }
  for (const args of [
    ["--since", "2026-02-30"], ["--limit", "0"], ["--limit", "2.5"], ["--exclude-project", ""],
  ]) assert.throws(() => parseOptions(args));
  await assert.rejects(main(["--home", HOME, "--root", ROOT, "--yes", "--server", "http://127.0.0.1"], {
    env: {}, log: () => assert.fail("Must reject before output"),
  }), /JINAI_MEMORY_TOKEN is required/u);
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /no --token option/u);
});

test("corrupt transcript state stops the combined import before any files are sent", async (t) => {
  const { home } = await homeWithSessions(t);
  await mkdir(path.join(home, ".jinai-memory"));
  await writeFile(path.join(home, ".jinai-memory", "transcript-state.json"), `{"private":"${TOKEN}"`);
  const { env, calls } = await setup(t);
  const result = await cli(["--home", home, "--yes"], env);
  assert.equal(result.code, 1);
  assert.equal(calls.length, 0);
  assert.match(result.stderr, /Transcript state is not valid JSON/u);
  assert.ok(!result.stderr.includes(TOKEN));
});
