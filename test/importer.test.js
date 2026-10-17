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

test("importer maps skill metadata and memory kinds without ineligible project tags", async () => {
  const entries = await plan();
  const named = (title) => entries.find((entry) => entry.memory.title === title).memory;
  assert.deepEqual(named("paper-folding"), {
    kind: "fact", title: "paper-folding",
    summary: "Make a checklist for folding imaginary paper shapes.",
    text: "## Steps\nUse a square sheet in the fictional workshop.\nCheck each fold before continuing.",
    tags: ["paper-folding"],
  });
  assert.deepEqual(named("star-sorting").tags, ["star-sorting"]);
  assert.equal(named("Compact workshop answers").kind, "preference");
  assert.equal(named("Orbit palette decision").kind, "decision");
  for (const title of ["Workshop preference", "Imaginary shape glossary", "Untyped workshop note"]) {
    assert.equal(named(title).kind, "fact");
  }
  const memories = entries.filter((entry) => entry.from.includes("/projects/"));
  assert.equal(memories.length, 5);
  for (const entry of memories) {
    assert.deepEqual(entry.memory.tags, []);
    assert.ok(!JSON.stringify(entry.memory).includes("C--Workshop"));
  }
  assert.ok(!named("Untyped workshop note").tags.includes("unknown"));
  const unfamiliar = planImport([{
    ...synthetic("---\nmetadata:\n  type: unusual\n---\nFictional note.", "memory"),
    project: "C:\\Workshop\\orbit",
  }], { home: HOME })[0];
  assert.equal(unfamiliar.memory.kind, "fact");
  assert.deepEqual(unfamiliar.memory.tags, []);
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

test("importer extracts shared concrete name words longer than two characters and preserves skill names", () => {
  const name = "Fabrikam-Pricing-AI-UX-a-Fabrikam-Billing-Extra";
  for (const type of ["skills", "copilot", "memory"]) {
    const [entry] = planImport(Array.from({ length: 8 }, (_, index) => synthetic(
      `---\nname: ${index < 2 ? name : `other-${index}`}\nmetadata:\n  type: feedback\n---\nbody.`,
      type, `note-${index}.md`,
    )), { home: HOME });
    assert.deepEqual(entry.memory.tags, [
      "Fabrikam", "Pricing", "Billing", "Extra", ...(type === "memory" ? [] : [name]),
    ]);
    assert.ok(entry.memory.tags.length <= 10);
    assert.equal(new Set(entry.memory.tags).size, entry.memory.tags.length);
    assert.ok(["AI", "UX", "a"].every((tag) => !entry.memory.tags.includes(tag)));
  }
  const [duplicate] = makePlan("---\nname: skill-skill-post\n---\nBody.");
  assert.deepEqual(duplicate.memory.tags, ["skill-skill-post"]);
  const [short] = makePlan("---\nname: ai-ux-a\n---\nBody.");
  assert.deepEqual(short.memory.tags, ["ai-ux-a"]);
  const [fallback] = makePlan("Body.", "memory", "copilot-pricing.md");
  assert.deepEqual(fallback.memory.tags, []);
});

test("importer derives instruction tags from heading words outside parentheses", () => {
  const heading = "Fabrikam Pricing (Private Notes) Billing \uFF08Internal Only\uFF09 Fabrikam Limits Extra";
  const [entry] = planImport(Array.from({ length: 8 }, (_, index) => synthetic(
    `## ${index < 2 ? heading : `other-${index}`}\nguidance.`,
    "claude-md", `guide-${index}.md`,
  )), { home: HOME });
  assert.deepEqual(entry.memory.tags, [
    "Fabrikam", "Pricing", "Billing", "Limits", "Extra",
  ]);
  assert.ok(entry.memory.tags.length <= 10);
  assert.equal(new Set(entry.memory.tags).size, entry.memory.tags.length);
  const [short] = makePlan("## AI UX (private)\nFictional guidance.", "include", "extra.md");
  assert.deepEqual(short.memory.tags, []);
});

test("importer removes classification tags instead of merely de-duplicating them", () => {
  const [entry] = planImport([{
    ...synthetic("---\nname: memory-memory-feedback\nmetadata:\n  type: memory\n---\nBody.", "memory"),
    project: "memory",
  }], { home: HOME });
  assert.deepEqual(entry.memory.tags, []);
});

test("importer never tags classification names, metadata types, or hex IDs across input categories", () => {
  const excluded = [
    "memory", "feedback", "project", "user", "reference", "unknown",
    "instructions", "skill", "claude-code", "copilot", "unusual",
    "83fb83", "a96573", "A96573", "123456", "a96573abcdef",
  ];
  const inputs = excluded.flatMap((name, index) => [
    synthetic(`---\nname: ${name}\n---\nbody.`, "skills", `skill-${index}.md`),
    synthetic(`---\nname: ${name}\n---\nbody.`, "copilot", `copilot-${index}.md`),
    {
      ...synthetic(`---\nmetadata:\n  type: ${name}\n---\nbody.`, "memory", `note-${index}.md`),
      project: `C--Workshop-${name}`,
    },
    synthetic(`## ${name}\nbody.`, "include", `guide-${index}.md`),
  ]);
  const entries = planImport(inputs, { home: HOME });
  for (const { memory } of entries) {
    assert.ok(memory.tags.every((tag) => !excluded.includes(tag)));
    assert.ok(memory.tags.every((tag) => !/^(?=[a-f\d]*\d)[a-f\d]{6,}$/iu.test(tag)));
  }
  const [word] = planImport(Array.from({ length: 8 }, (_, index) => ({
    ...synthetic(index < 2 ? "Decade" : "body.", "memory", `note-${index}.md`),
    project: "C--Workshop-decade",
  })), { home: HOME });
  assert.deepEqual(word.memory.tags, ["Decade"]);
});

test("importer selects repeated concrete topics but not singleton, broad, generic, or lowercase-only words", () => {
  const inputs = Array.from({ length: 8 }, (_, index) => synthetic([
    index < 2 ? "Fabrikam Fabrikam 料金 ダッシュボード ordinary" : "",
    index < 3 ? "Contoso" : "",
    index === 0 ? "Singleton" : "",
    index < 2 ? "The This When Use 確認 作業 必要 場合 ファイル フォルダ スキル ユーザー テスト タスク" : "",
  ].join("\n"), "memory", `note-${index}.md`));
  const entries = planImport(inputs, { home: HOME });
  assert.deepEqual(entries[0].memory.tags, ["Fabrikam", "料金", "ダッシュボード"]);
  assert.deepEqual(entries[1].memory.tags, entries[0].memory.tags);
  assert.ok(entries.slice(2).every(({ memory }) => memory.tags.length === 0));
  assert.deepEqual(inputs.map((file) => file.text), entries.map(({ memory }) => memory.text));
});

test("importer counts each memory once at the inclusive 25-percent boundary", () => {
  const inputs = Array.from({ length: 8 }, (_, index) => synthetic(
    index < 2 ? "Fabrikam ".repeat(10) : "body.", "memory", `note-${index}.md`,
  ));
  assert.deepEqual(planImport(inputs, { home: HOME })[0].memory.tags, ["Fabrikam"]);
  assert.deepEqual(planImport(inputs.slice(0, 7), { home: HOME })[0].memory.tags, []);
  inputs[1] = { ...inputs[1], text: "body." };
  assert.deepEqual(planImport(inputs, { home: HOME })[0].memory.tags, []);
});

test("importer counts split instructions as memories and extracts topics from title, summary, and body", () => {
  const sections = Array.from({ length: 8 }, (_, index) =>
    `## ${index < 2 ? "Fabrikam" : `section-${index}`}\n${index < 2 ? "料金" : "body."}`);
  const entries = makePlan(sections.join("\n"), "include", "guide.md");
  assert.equal(entries.length, 8);
  assert.deepEqual(entries[0].memory.tags, ["Fabrikam", "料金"]);
  assert.deepEqual(entries[1].memory.tags, entries[0].memory.tags);
  const summaries = planImport(Array.from({ length: 8 }, (_, index) => synthetic(
    `---\ndescription: ${index < 2 ? "Fabrikam" : "brief"}\n---\nbody.`,
    "memory", `note-${index}.md`,
  )), { home: HOME });
  assert.deepEqual(summaries[0].memory.tags, ["Fabrikam"]);
});

test("importer merges case variants using the most frequent permitted spelling", () => {
  const inputs = Array.from({ length: 8 }, (_, index) => synthetic(
    index === 0 ? "Copilot Copilot copilot Fabrikam Fabrikam FABRIKAM fabrikam fabrikam" :
      index === 1 ? "Copilot copilot FABRIKAM fabrikam" : "body.",
    "memory", `note-${index}.md`,
  ));
  const entries = planImport(inputs, { home: HOME });
  assert.deepEqual(entries[0].memory.tags, ["fabrikam", "Copilot"]);
  assert.deepEqual(entries[1].memory.tags, ["Copilot", "fabrikam"]);
  inputs[0] = { ...inputs[0], text: "Copilot copilot copilot" };
  inputs[1] = { ...inputs[1], text: "copilot" };
  assert.deepEqual(planImport(inputs, { home: HOME })[0].memory.tags, []);
});

test("importer excludes sentence-case common English words whose lowercase occurrences dominate", () => {
  const words = ["For", "One", "Design", "Writer", "Report", "Review", "Application", "Company"];
  const entries = planImport(Array.from({ length: 8 }, (_, index) => synthetic(
    index === 0 ? words.map((word) => `${word} ${word.toLowerCase()}`).join("\n") :
      index === 1 ? words.join(" ").toLowerCase() : "body.",
    "memory", `note-${index}.md`,
  )), { home: HOME });
  assert.ok(entries.every(({ memory }) => memory.tags.length === 0));
});

test("importer requires a strict uppercase-majority across occurrences, not memories", () => {
  for (const [capitalized, lowercase, included] of [[1, 3, false], [2, 2, false], [3, 2, true]]) {
    const entries = planImport(Array.from({ length: 8 }, (_, index) => synthetic(
      index === 0 ? "Fabrikam ".repeat(capitalized) :
        index === 1 ? "fabrikam ".repeat(lowercase) : "body.",
      "memory", `note-${index}.md`,
    )), { home: HOME });
    assert.deepEqual(entries[0].memory.tags, included ? ["Fabrikam"] : [], `${capitalized}/${capitalized + lowercase}`);
    assert.deepEqual(entries[1].memory.tags, entries[0].memory.tags);
  }
});

test("importer removes path and URL chunks before extracting English and Japanese topics", () => {
  const body = [
    "C:\\Contoso\\Fabrikam-Drive\\note.md",
    "C:\\カタログ\\架空料金\\note.md",
    "https://Contoso.example/Fabrikam/Drive?category=架空料金#カタログ",
    "HTTP://Contoso.example/Fabrikam/Drive",
    "/Contoso/Fabrikam-Drive/note.md",
    ".\\Contoso\\Fabrikam-Drive\\note.md",
    "\\\\Contoso\\Fabrikam-Drive\\note.md",
    "`assets/Fabrikam-Drive/note.md`",
  ].join("\n");
  const entries = planImport(Array.from({ length: 8 }, (_, index) => synthetic(
    index < 2 ? body : "body.", "memory", `note-${index}.md`,
  )), { home: HOME });
  assert.ok(entries.every(({ memory }) => memory.tags.length === 0));
  assert.equal(entries[0].memory.text, body);
});

test("importer removes path and URL noise from titles, summaries, and instruction headings", () => {
  const noise = "C:\\Contoso\\Fabrikam-Drive\\note.md https://Contoso.example/Archive";
  for (const field of ["name", "description", "heading"]) {
    const entries = planImport(Array.from({ length: 8 }, (_, index) => synthetic(
      field === "heading" ? `## ${index < 2 ? noise : `section-${index}`}\nbody.` :
        `---\n${field}: ${index < 2 ? noise : `note-${index}`}\n---\nbody.`,
      field === "heading" ? "include" : "memory", `note-${index}.md`,
    )), { home: HOME });
    assert.ok(entries.every(({ memory }) => memory.tags.length === 0), field);
  }
});

test("importer excludes common Japanese action words while preserving concrete topics", () => {
  const entries = planImport(Array.from({ length: 8 }, (_, index) => synthetic(index < 2 ? [
    "作成 生成 報告 開発 更新 取得 出力 入力 表示 管理 対応 判断 指示 セッション",
    "Fabrikam 料金 Copilot",
  ].join("\n") : "body.", "memory", `note-${index}.md`)), { home: HOME });
  assert.deepEqual(entries[0].memory.tags, ["Fabrikam", "料金", "Copilot"]);
  assert.deepEqual(entries[1].memory.tags, entries[0].memory.tags);
});

test("importer excludes formatting headings while keeping concrete topics", () => {
  const entries = planImport(Array.from({ length: 8 }, (_, index) => ({
    ...synthetic(index < 2 ? [
      "**Why:** Fabrikam 料金 Copilot",
      "**How to apply:**",
      "**Apply:** **Step:** **Steps:** **Audit:** **URL:** **Note:**",
    ].join("\n") : "body.", "memory", `note-${index}.md`),
    project: "C--Users-Contoso-workshop-Why",
  })), { home: HOME });
  assert.deepEqual(entries[0].memory.tags, ["Fabrikam", "料金", "Copilot"]);
  assert.deepEqual(entries[1].memory.tags, entries[0].memory.tags);
  assert.ok(entries.slice(2).every(({ memory }) => memory.tags.length === 0));
});

test("importer gates project suffixes by the same corpus conditions as content topics", () => {
  for (const [project, bodies, expected] of [
    ["verify", ["body.", "body."], []],
    ["verify", ["Verify", "body."], []],
    ["Verify", ["verify", "verify"], []],
    ["Verify", ["Verify verify", "verify"], []],
    ["Verify", ["Verify", "Verify", "Verify"], []],
    ["Why", ["Why", "Why"], []],
    ["fabrikam", ["Fabrikam", "Fabrikam"], ["Fabrikam"]],
  ]) {
    const entries = planImport(Array.from({ length: 8 }, (_, index) => ({
      ...synthetic(bodies[index] ?? "body.", "memory", `note-${index}.md`),
      project: `C--Users-Contoso-workshop-${project}`,
    })), { home: HOME });
    for (const { memory } of entries) assert.deepEqual(memory.tags, expected, `${project}: ${bodies}`);
  }
});

test("importer keeps only the five most frequent topics per memory and de-duplicates base tags", () => {
  const names = ["Fabrikam", "Contoso", "料金", "機密", "承認", "ダッシュボード", "ワークショップ"];
  const inputs = Array.from({ length: 8 }, (_, index) => ({
    ...synthetic(index < 2 ? names.map((name, rank) => `${name} `.repeat(rank + 1)).join("\n") : "body.",
      "memory", `note-${index}.md`),
    project: "C--Workshop-fabrikam",
  }));
  const entries = planImport(inputs, { home: HOME });
  assert.deepEqual(entries[0].memory.tags, [...names.slice(2).reverse(), "Fabrikam"]);
  assert.ok(entries.every(({ memory }) => memory.tags.length <= 10 &&
    new Set(memory.tags.map((tag) => tag.toLowerCase())).size === memory.tags.length));
  inputs[0] = { ...inputs[0], project: "C--Workshop-ワークショップ" };
  const [duplicate] = planImport(inputs, { home: HOME });
  assert.equal(duplicate.memory.tags.length, 5);
  assert.equal(duplicate.memory.tags.filter((tag) => tag === "ワークショップ").length, 1);
});

test("importer still checks secrets in project tags removed by topic eligibility", () => {
  const fake = `ghp_${"fictional".repeat(4)}`;
  const [entry] = planImport([{
    ...synthetic("safe body.", "memory", "safe.md"), project: fake,
  }], { home: HOME });
  assert.equal(entry.secret, "github_token");
  assert.equal(entry.status, "secret-skip");
  assert.deepEqual(entry.memory.tags, []);
  assert.ok(!formatImportList([entry]).includes(fake));
});

test("importer hashes corpus-driven tag changes even when source text is unchanged", () => {
  const inputs = Array.from({ length: 8 }, (_, index) => synthetic(
    index < 2 ? "Fabrikam" : "body.", "memory", `note-${index}.md`,
  ));
  const before = planImport(inputs, { home: HOME });
  const state = Object.fromEntries(before.map(({ key, hash }) => [key, hash]));
  const after = planImport(inputs.map((file, index) =>
    index === 2 ? { ...file, text: "Fabrikam" } : file), { home: HOME, state });
  assert.deepEqual(after.slice(0, 3).map(({ change }) => change), ["changed", "changed", "changed"]);
  assert.ok(after.slice(3).every(({ change }) => change === "unchanged"));
  assert.deepEqual(after[0].memory.tags, []);
});

test("imported concrete topics produce an orient map without classification or project IDs", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  const memory = createMemory({ store, embedder: createEmbedder({ provider: "fake", dim: 16 }) });
  const entries = planImport(Array.from({ length: 8 }, (_, index) => ({
    ...synthetic(index < 2 ? [
      "---", "description: useful detail.", "---",
      "Fabrikam 料金 Copilot",
      "For for for Design design design",
      "作成 生成 報告 開発 更新 取得 出力 入力 表示 管理 対応 判断 指示 セッション",
      "C:\\Contoso\\Archive-Drive\\note.md https://Contoso.example/Archive",
    ].join("\n") : "body.", "memory", `note-${index}.md`),
    project: "C--Workshop-83fb83",
  })), { home: HOME });
  for (const entry of entries) {
    await memory.remember({ user: "fictional", source: "claude-code", ...entry.memory });
  }
  const result = await memory.orient({ user: "fictional" });
  assert.match(result, /Fabrikam・料金・Copilot —/u);
  assert.doesNotMatch(result, /skill|memory|feedback|instructions|claude-code|copilot|83fb83/u);
  assert.equal(result.split("\n").length, 2);
  assert.equal((await store.listNodes({ user: "fictional", label: "Memory" })).length, 8);
});

test("importer displays home paths with tilde and outside paths as slash-normalized absolute paths", () => {
  const filenames = [
    path.join(HOME, "inside.md"),
    path.join(HOME, "subdirectory", "..", "normalized.md"),
    path.resolve(HOME, "..", "outside.md"),
    path.resolve(`${HOME.replace(/[\\/]$/u, "")}-sibling`, "outside.md"),
  ];
  const entries = planImport(filenames.map((filename) => ({
    filename, type: "include", text: "Fictional instructions.",
  })), { home: HOME });
  assert.deepEqual(entries.map((entry) => entry.from), [
    "~/inside.md", "~/normalized.md",
    ...filenames.slice(2).map((filename) => path.resolve(filename).replaceAll("\\", "/")),
  ]);
  assert.ok(entries.every((entry) => !entry.from.includes("\\")));
  const listing = formatImportList(entries);
  assert.ok(listing.includes(entries[2].from));
  assert.ok(!listing.includes("~/../"));
  if (process.platform === "win32") {
    const drive = path.parse(HOME).root[0].toUpperCase() === "G" ? "H" : "G";
    const filename = `${drive}:\\fictional\\outside.md`;
    const [outside] = planImport([{ filename, type: "include", text: "Fictional." }], { home: HOME });
    assert.equal(outside.from, `${drive}:/fictional/outside.md`);
    assert.ok(!formatImportList([outside]).includes(`~/${drive}:/`));
  }
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
  assert.deepEqual(entries[1].memory.tags, []);
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
    `C:\\Contoso\\${fake}\\note.md`,
    `https://example.test/${fake}`,
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
