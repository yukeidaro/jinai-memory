import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { main, parseOptions } from "../scripts/import-local.mjs";
import { createEmbedder } from "../src/embedder.js";
import { createEventHub } from "../src/events.js";
import {
  IMPORT_TYPES, discoverFiles, formatImportList, importEndpoint, parseFrontmatter,
  parseImportState, planImport, sendImports,
} from "../src/importer.js";
import { createMemory } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const HOME = fileURLToPath(new URL("./fixtures/import-home/", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/import-local.mjs", import.meta.url));
const TOKEN = "devtoken-aaaaaaaaaaaaaaaaaaaaaaaa";
const io = { readFile, readdir };
const files = () => discoverFiles({ home: HOME, io });
const plan = async (state = {}) => planImport(await files(), { home: HOME, state });
const synthetic = (text, type = "skills", name = "SKILL.md") => ({
  filename: path.join(HOME, name), type, text,
});
const makePlan = (text, type, name) => planImport([synthetic(text, type, name)], { home: HOME });

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "importer-fictional-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function setup(t, token = TOKEN) {
  const store = createMemoryStore();
  const hub = createEventHub();
  await store.ensureIndexes({ user: "fictional", dim: 16 });
  const memory = createMemory({
    store, embedder: createEmbedder({ provider: "fake", dim: 16 }), onTouch: hub.publish,
  });
  const server = createServer({ store, memory, hub, token, user: "fictional" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const graph = async () => {
    const response = await fetch(`${base}/api/graph?token=${encodeURIComponent(token)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { store, base, token, graph };
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

test("importer discovers all four categories and excludes the MEMORY.md index", async () => {
  const discovered = await files();
  assert.deepEqual([...new Set(discovered.map((file) => file.type))].sort(), [...IMPORT_TYPES].sort());
  assert.equal(discovered.length, 8);
  assert.ok(discovered.every((file) => path.basename(file.filename) !== "MEMORY.md"));
  const entries = planImport(discovered, { home: HOME });
  assert.equal(entries.length, 9);
  assert.ok(entries.every((entry) => entry.from.startsWith("~/.") && !entry.from.includes("\\")));
  assert.ok(entries.every((entry) => entry.status === "new"));
});

test("importer maps skill metadata, memory kinds, and only a short project tag", async () => {
  const entries = await plan();
  const named = (title) => entries.find((entry) => entry.memory.title === title).memory;
  assert.deepEqual(named("paper-folding"), {
    kind: "fact", title: "paper-folding",
    summary: "Make a checklist for folding imaginary paper shapes.",
    text: "## Steps\nUse a square sheet in the fictional workshop.\nCheck each fold before continuing.",
    tags: ["skill", "paper-folding", "claude-code"],
  });
  assert.deepEqual(named("star-sorting").tags, ["skill", "star-sorting", "copilot"]);
  assert.equal(named("Compact workshop answers").kind, "preference");
  assert.equal(named("Orbit palette decision").kind, "decision");
  for (const title of ["Workshop preference", "Imaginary shape glossary", "Untyped workshop note"]) {
    assert.equal(named(title).kind, "fact");
  }
  const memories = entries.filter((entry) => entry.memory.tags[0] === "memory");
  assert.equal(memories.length, 5);
  for (const entry of memories) {
    assert.equal(entry.memory.tags[2], "orbit");
    assert.ok(!JSON.stringify(entry.memory).includes("C--Workshop"));
  }
  assert.equal(named("Untyped workshop note").tags[1], "unknown");
  const unfamiliar = planImport([{
    ...synthetic("---\nmetadata:\n  type: unusual\n---\nFictional note.", "memory"),
    project: "C:\\Workshop\\orbit",
  }], { home: HOME })[0];
  assert.equal(unfamiliar.memory.kind, "fact");
  assert.deepEqual(unfamiliar.memory.tags, ["memory", "unusual", "orbit"]);
});

test("importer supports category filters, repeated includes, and duplicate file avoidance", async () => {
  const included = path.join(HOME, "extra.md");
  const discovered = await discoverFiles({
    home: HOME, only: ["copilot"], include: [included, included], io,
  });
  assert.deepEqual(discovered.map((file) => file.type), ["copilot", "include"]);
  assert.equal(planImport(discovered, { home: HOME }).length, 3);
  const duplicate = path.join(HOME, ".claude", "skills", "paper-folding", "SKILL.md");
  assert.equal((await discoverFiles({ home: HOME, io, include: [duplicate] })).length, 8);
  const options = parseOptions([
    "--home", HOME.replaceAll("\\", "/"), "--only", "skills,copilot",
    "--include", included, "--include", included.replaceAll("\\", "/"),
  ], "unused");
  assert.equal(options.home, path.resolve(HOME));
  assert.equal(options.include.length, 2);
  assert.deepEqual(options.only, ["skills", "copilot"]);
});

test("importer parses minimal nested, quoted, BOM, CRLF, and block frontmatter", () => {
  const parsed = parseFrontmatter('\uFEFF---\r\nname: "paper"\r\ndescription: |\r\n  First line.\r\n  Second line.\r\nmetadata:\r\n  type: feedback\r\n---\r\nBody.');
  assert.equal(parsed.attributes.name, "paper");
  assert.equal(parsed.attributes.description, "First line.\nSecond line.");
  assert.equal(parsed.attributes.metadata.type, "feedback");
  assert.equal(parsed.body, "Body.");
  assert.equal(parseFrontmatter("---\nname: 'a ''quoted'' label'\n---\nBody").attributes.name, "a 'quoted' label");
  assert.equal(parseFrontmatter("---\ndescription: >-\n  First line.\n  Continued.\n---\nBody").attributes.description, "First line. Continued.");
  const entry = makePlan(`---\ndescription: "${"z".repeat(180)}\\nSecond line."\n---\nBody`)[0];
  assert.equal(entry.memory.summary, "z".repeat(160));
  assert.equal(makePlan('---\ndescription: "First line.\\rSecond line."\n---\nBody')[0].memory.summary, "First line.");
  assert.throws(() => parseFrontmatter("---\nname: broken"), /closing delimiter/u);
  assert.throws(() => parseFrontmatter('---\nname: "broken\n---'), /quoted frontmatter/u);
});

test("importer splits instructions by H2 while preserving preambles and fenced headings", () => {
  const entries = makePlan([
    "Preamble instructions.", "## Style", "Keep it brief.",
    "```md", "## Not a heading", "```",
    "~~~markdown", "## Also not a heading", "~~~",
    "### Details", "More detail.", "## Review ###", "Check once.",
  ].join("\n"), "include", "extra.md");
  assert.deepEqual(entries.map((entry) => entry.memory.title), ["extra.md", "extra.md / Style", "extra.md / Review"]);
  assert.ok(entries.every((entry) => entry.memory.kind === "preference"));
  assert.deepEqual(entries[1].memory.tags, ["instructions", "Style"]);
  assert.match(entries[1].memory.text, /## Not a heading/u);
  assert.match(entries[1].memory.text, /### Details/u);
  assert.equal(makePlan("Whole file.", "claude-md", "CLAUDE.md")[0].memory.text, "Whole file.");
  assert.equal(makePlan("", "include", "empty.md").length, 1);
});

test("importer truncates at exactly 20,000 Unicode characters including its marker", () => {
  for (const character of ["a", "\u{1F680}"]) {
    const [entry] = makePlan(character.repeat(20_001));
    assert.equal(entry.status, "truncated");
    assert.equal(entry.chars, 20_000);
    assert.equal(Array.from(entry.memory.text).length, 20_000);
    assert.ok(entry.memory.text.endsWith("\n\n(truncated)"));
    assert.ok(!entry.memory.text.includes("\uFFFD"));
    const [boundary] = makePlan(character.repeat(20_000));
    assert.equal(boundary.status, "new");
    assert.equal(boundary.truncated, false);
  }
});

test("importer checks secrets in untruncated text, frontmatter, metadata, and each instruction", async () => {
  const fake = `sk-${"fictional".repeat(4)}`;
  const inputs = [
    fake,
    `${"a".repeat(20_100)}\n${fake}`,
    `---\nname: ${fake}\n---\nSafe body.`,
    `---\ndescription: ${fake}\n---\nSafe body.`,
    `---\nunrelated: ${fake}\n---\nSafe body.`,
  ];
  const entries = inputs.flatMap((input) => makePlan(input));
  assert.ok(entries.every((entry) => entry.status === "secret-skip" && entry.secret === "api_key"));
  const instructions = makePlan(`## Safe\nFictional instructions.\n## Unsafe\n${fake}`, "claude-md");
  assert.deepEqual(instructions.map((entry) => entry.status), ["new", "secret-skip"]);
  const secretPath = makePlan("Safe body.", "skills", `${fake}.md`);
  assert.equal(secretPath[0].status, "secret-skip");
  const output = formatImportList([...entries, ...secretPath]);
  assert.match(output, /secret-skip \(api_key\)/u);
  assert.ok(!output.includes(fake));
  let calls = 0;
  const result = await sendImports(entries, {
    endpoint: new URL("http://127.0.0.1/"), state: {},
    fetchImpl: () => { calls += 1; throw new Error("Must not send."); },
    saveState: () => { throw new Error("Must not save."); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, { success: 0, failed: 0, skipped: entries.length });
});

test("importer hashes unchanged, changed, truncated, and repeated-heading entries independently", async () => {
  const initial = await plan();
  const state = Object.fromEntries(initial.map((entry) => [entry.key, entry.hash]));
  assert.ok((await plan(state)).every((entry) => entry.status === "unchanged"));
  const original = synthetic("## Same\nFirst.\n## Same\nSecond.", "include");
  const before = planImport([original], { home: HOME });
  assert.notEqual(before[0].key, before[1].key);
  const saved = Object.fromEntries(before.map((entry) => [entry.key, entry.hash]));
  const after = planImport([{ ...original, text: original.text.replace("Second.", "Changed.") }], { home: HOME, state: saved });
  assert.deepEqual(after.map((entry) => entry.status), ["unchanged", "changed"]);
  const long = makePlan("x".repeat(20_001))[0];
  assert.equal(planImport([synthetic("x".repeat(20_001))], {
    home: HOME, state: { [long.key]: long.hash },
  })[0].status, "unchanged");
  assert.notEqual(long.hash, makePlan(`${"x".repeat(20_001)}tail`)[0].hash);
});

test("dry run makes zero requests, writes no state, and never prints bodies or summaries", async (t) => {
  const directory = await temporary(t);
  const state = path.join(directory, "not-created", "state.json");
  const output = [];
  let requests = 0;
  await main(["--home", HOME, "--state", state], {
    env: {}, fetchImpl: () => { requests += 1; throw new Error("No network."); },
    log: (line) => output.push(line),
  });
  assert.equal(requests, 0);
  await assert.rejects(readFile(state), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
  const text = output.join("\n");
  assert.match(text, /status\s+\|\s+kind\s+\|\s+title\s+\|\s+from\s+\|\s+chars/u);
  assert.match(text, /Total: 9; new=9/u);
  assert.match(text, /rerun with --yes/u);
  assert.ok(!text.includes("Use a square sheet"));
  assert.ok(!text.includes("Make a checklist for folding"));
  assert.ok(!text.includes(path.resolve(HOME)));
});

test("--yes CLI imports into the real memory-store graph; a second run sends nothing", async (t) => {
  const { base, graph, store } = await setup(t);
  const directory = await temporary(t);
  const state = path.join(directory, "state.json");
  const args = ["--home", HOME, "--state", state];
  const env = { JINAI_MEMORY_URL: base, JINAI_MEMORY_TOKEN: TOKEN };
  const dry = await cli(args, env);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal((await graph()).nodes.filter((node) => node.kind).length, 0);
  const sent = await cli([...args, "--yes"], env);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /success=9, failed=0, skipped=0/u);
  const memories = (await graph()).nodes.filter((node) => node.kind);
  assert.equal(memories.length, 9);
  assert.ok(memories.every((node) => node.source === "claude-code"));
  assert.equal((await store.listNodes({ user: "another-fictional", label: "Memory" })).length, 0);
  const saved = parseImportState(await readFile(state, "utf8"));
  assert.equal(Object.keys(saved).length, 9);
  assert.ok(Object.values(saved).every((hash) => /^[a-f0-9]{64}$/u.test(hash)));
  assert.ok(!JSON.stringify(saved).includes("Use a square sheet"));
  const again = await cli(args, env);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /new=0, changed=0, unchanged=9, secret-skip=0, truncated=0/u);
  const twice = await cli([...args, "--yes"], env);
  assert.equal(twice.code, 0, twice.stderr);
  assert.match(twice.stdout, /success=0, failed=0, skipped=9/u);
  assert.equal((await graph()).nodes.filter((node) => node.kind).length, 9);
});

test("--yes skips fictional secrets before HTTP and imports changed entries as new memories", async (t) => {
  const { base, graph } = await setup(t);
  const directory = await temporary(t);
  const state = path.join(directory, "state.json");
  const include = path.join(directory, "fictional.md");
  const fake = `ghp_${"fictional".repeat(4)}`;
  await writeFile(include, `## Safe\nFirst version.\n## Unsafe\n${fake}`);
  const args = ["--home", HOME, "--only", "copilot", "--include", include, "--state", state, "--yes"];
  const env = { JINAI_MEMORY_URL: base, JINAI_MEMORY_TOKEN: TOKEN };
  const output = [];
  const bodies = [];
  const run = () => main(args, {
    env, log: (line) => output.push(line),
    fetchImpl: (url, options) => { bodies.push(options.body); return fetch(url, options); },
  });
  assert.deepEqual(await run(), { success: 2, failed: 0, skipped: 1 });
  assert.ok(bodies.every((body) => !body.includes(fake)));
  assert.equal((await graph()).nodes.filter((node) => node.kind).length, 2);
  await writeFile(include, `## Safe\nSecond version.\n## Unsafe\n${fake}`);
  assert.deepEqual(await run(), { success: 1, failed: 0, skipped: 2 });
  assert.match(output.join("\n"), /changed/u);
  assert.ok(!output.join("\n").includes(fake));
  assert.equal((await graph()).nodes.filter((node) => node.kind).length, 3);
  assert.equal(Object.keys(parseImportState(await readFile(state, "utf8"))).length, 2);
});

test("importer sends sequentially, continues after safe failures, and persists only successes", async () => {
  const entries = await plan();
  const state = {};
  const snapshots = [];
  const failures = [];
  let active = 0;
  let maximum = 0;
  let errorBodyCancelled = false;
  const responses = [
    () => { throw new Error(`${TOKEN} password: fictional-value`); },
    () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`password: fictional-value ${TOKEN}`));
      },
      cancel() { errorBodyCancelled = true; },
    }), { status: 503 }),
    () => new Response(`password: fictional-value ${TOKEN}`),
    (id) => Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: TOKEN } }),
    (id) => Response.json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: TOKEN }] } }),
    (id) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "{}" }] } }),
  ];
  let calls = 0;
  const result = await sendImports(entries, {
    endpoint: importEndpoint("http://127.0.0.1", TOKEN, "claude-code"),
    state, saveState: async (next) => { snapshots.push(structuredClone(next)); },
    onFailure: (index, reason) => failures.push({ index, reason }),
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, "error");
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        const { id } = JSON.parse(options.body);
        const response = responses[calls++];
        await new Promise((resolve) => setTimeout(resolve, 1));
        return response ? response(id) : Response.json({
          jsonrpc: "2.0", id, result: { content: [{ type: "text", text: '{"id":"fictional-memory"}' }] },
        });
      } finally {
        active -= 1;
      }
    },
  });
  assert.equal(maximum, 1);
  assert.deepEqual(result, { success: 3, failed: 6, skipped: 0 });
  assert.deepEqual(Object.keys(state), entries.slice(6).map((entry) => entry.key));
  assert.equal(snapshots.length, 3);
  assert.equal(failures.length, 6);
  assert.equal(errorBodyCancelled, true);
  assert.match(failures[1].reason, /HTTP 503/u);
  assert.ok(!JSON.stringify(failures).includes(TOKEN));
  assert.ok(!JSON.stringify(failures).includes("fictional-value"));
});

test("importer rechecks payloads at send time and stops if successful writes cannot be tracked", async () => {
  const [entry] = await plan();
  const altered = structuredClone(entry);
  altered.memory.text = "password: fictional-value";
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    return Response.json({
      jsonrpc: "2.0", id: JSON.parse(options.body).id,
      result: { content: [{ type: "text", text: '{"id":"fictional-memory"}' }] },
    });
  };
  const state = {};
  assert.deepEqual(await sendImports([altered], {
    endpoint: new URL("http://127.0.0.1/"), state, fetchImpl, saveState: () => {},
  }), { success: 0, failed: 0, skipped: 1 });
  assert.equal(calls, 0);
  await assert.rejects(sendImports([entry, entry], {
    endpoint: new URL("http://127.0.0.1/"), state, fetchImpl,
    saveState: () => { throw new Error(TOKEN); },
  }), /state could not be written/u);
  assert.equal(calls, 1);
  assert.deepEqual(state, {});
});

test("importer rejects token arguments without echoing their values and requires environment consent", async (t) => {
  for (const args of [
    ["--token", TOKEN], [`--token=${TOKEN}`], [TOKEN],
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: {}, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Tokens must only be set in JINAI_MEMORY_TOKEN/u);
    assert.ok(!result.stderr.includes(TOKEN));
    assert.equal(result.stdout, "");
  }
  const directory = await temporary(t);
  await assert.rejects(main([
    "--home", HOME, "--state", path.join(directory, "state.json"), "--yes", "--server", "http://127.0.0.1",
  ], { env: {}, log: () => {} }), /JINAI_MEMORY_TOKEN is required/u);
  assert.throws(() => parseOptions(["--only", "skills,unknown"], HOME), /--only/u);
  assert.throws(() => parseOptions(["--source", "Invalid"], HOME), /--source/u);
  for (const server of ["not a url", "file:///fictional", "http://fictional:secret@localhost", "http://localhost/?token=fictional"]) {
    assert.throws(() => importEndpoint(server, TOKEN, "claude-code"), /HTTP|server URL/u);
  }
});

test("importer supports encoded environment tokens, --server override, and custom source", async (t) => {
  const token = "fictional+/=token";
  const { base, graph } = await setup(t, token);
  const directory = await temporary(t);
  const output = [];
  const result = await main([
    "--home", HOME, "--only", "copilot", "--state", path.join(directory, "state.json"),
    "--yes", "--server", base, "--source", "local-import",
  ], {
    env: { JINAI_MEMORY_URL: "not a URL", JINAI_MEMORY_TOKEN: token },
    log: (line) => output.push(line),
  });
  assert.deepEqual(result, { success: 1, failed: 0, skipped: 0 });
  const memories = (await graph()).nodes.filter((node) => node.kind);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].source, "local-import");
  assert.ok(!output.join("\n").includes(token));
});

test("importer reports corrupt state and read failures rather than silently reimporting", async (t) => {
  const directory = await temporary(t);
  const state = path.join(directory, "broken.json");
  await writeFile(state, `{"secret":"${TOKEN}"`);
  let requests = 0;
  await assert.rejects(main(["--home", HOME, "--state", state], {
    env: {}, log: () => {}, fetchImpl: () => { requests += 1; },
  }), /state is not valid JSON/u);
  assert.equal(requests, 0);
  for (const text of ["null", "[]", '{"version":1,"entries":{"entry":"not-a-hash"}}']) {
    assert.throws(() => parseImportState(text), /unsupported format/u);
  }
  await assert.rejects(discoverFiles({
    home: HOME, io, only: [], include: [path.join(directory, "missing.md")],
  }), /Could not read an import file/u);
  await assert.rejects(discoverFiles({
    home: HOME, io, only: [], include: ["fictional.txt"],
  }), /Markdown/u);
  await assert.rejects(discoverFiles({
    home: HOME, io: { ...io, readdir: async () => { throw new Error(TOKEN); } },
  }), /Could not list an import directory/u);
  assert.deepEqual(await discoverFiles({ home: directory, io }), []);
});
