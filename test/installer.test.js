import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { detectTools, main, readHiddenToken } from "../src/installer.js";

const BIN = fileURLToPath(new URL("../bin/jinai-memory.mjs", import.meta.url));
const TOKEN = "fictional-token+/=";
const SOURCES = ["claude-code", "cursor", "vscode", "copilot-cli", "codex", "gemini"];
const BASE = "https://jinai-memory.onrender.com";

async function temporary(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "jinai-installer-fictional-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

function locations(home, platform) {
  const cfg = platform === "win32" ? path.join(home, "AppData", "Roaming")
    : platform === "darwin" ? path.join(home, "Library", "Application Support")
      : path.join(home, ".config");
  return {
    "claude-code": path.join(home, ".claude.json"),
    cursor: path.join(home, ".cursor", "mcp.json"),
    vscode: path.join(cfg, "Code", "User", "mcp.json"),
    "copilot-cli": path.join(home, ".copilot", "mcp-config.json"),
    codex: path.join(home, ".codex", "config.toml"),
    gemini: path.join(home, ".gemini", "settings.json"),
  };
}

async function put(filename, contents) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, contents);
}

async function fixture(home, platform) {
  const files = locations(home, platform);
  const originals = {
    "claude-code": { projects: { fictional: { allowedTools: ["Read"] } }, mcpServers: { other: { command: "fictional" } } },
    cursor: { mcpServers: { other: { url: "https://example.invalid/other" } }, theme: "fictional" },
    vscode: { inputs: [{ id: "fictional", type: "promptString" }], servers: { other: { type: "stdio", command: "fictional" } }, extra: true },
    "copilot-cli": { mcpServers: { other: { command: "fictional", tools: ["read"] } } },
    codex: 'model = "fictional"\r\n# Leave these bytes alone.\r\n[mcp_servers.other]\r\ncommand = "fictional"',
    gemini: { security: { sandbox: true }, mcpServers: { other: { command: "fictional" } } },
  };
  for (const source of SOURCES) {
    await put(files[source], typeof originals[source] === "string"
      ? originals[source] : `${JSON.stringify(originals[source], null, 2)}\n`);
  }
  return { files, originals };
}

function hidden(text) {
  for (const secret of [TOKEN, encodeURIComponent(TOKEN)]) {
    assert.ok(!text.includes(secret), "A fictional token leaked");
  }
}

async function run(home, args, overrides = {}) {
  const stdout = [];
  const stderr = [];
  const code = await main([...args, "--home", home], {
    home, env: { JINAI_MEMORY_TOKEN: TOKEN }, platform: "win32",
    stdin: { isTTY: false }, stdout: { write: (text) => stdout.push(text) },
    log: (text) => stdout.push(text), error: (text) => stderr.push(text),
    ...overrides,
  });
  const result = { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  hidden(result.stdout + result.stderr);
  return result;
}

async function snapshot(directory) {
  const result = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, contents] of Object.entries(await snapshot(filename))) {
        result[path.join(entry.name, name)] = contents;
      }
    } else {
      result[entry.name] = (await fs.readFile(filename)).toString("base64");
    }
  }
  return result;
}

async function backups(filename) {
  return (await fs.readdir(path.dirname(filename))).filter((name) =>
    name.startsWith(`${path.basename(filename)}.jinai-backup-`));
}

for (const platform of ["win32", "darwin"]) {
  test(`${platform}: only existing tool locations are detected and listed`, async (t) => {
    const home = await temporary(t);
    await fs.mkdir(path.join(home, ".claude"));
    await fs.mkdir(path.join(home, ".cursor"));
    const tools = await detectTools({ home, env: {}, platform });
    assert.deepEqual(tools.filter((tool) => tool.found).map((tool) => tool.source), ["claude-code", "cursor"]);
    const before = await snapshot(home);
    const result = await run(home, ["init", "--dry-run", "--skip-import"], { platform });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Found: Claude Code \(claude-code\), Cursor \(cursor\)\n/u);
    assert.match(result.stdout, /Not found: VS Code \/ Copilot \(vscode\), Copilot CLI/u);
    assert.match(result.stdout, /Manual: claude.ai \/ Claude Desktop \(claude\), ChatGPT \(chatgpt\)/u);
    assert.deepEqual(await snapshot(home), before);
  });

  test(`${platform}: all shapes, backups, idempotence and lossless removal`, async (t) => {
    const home = await temporary(t);
    const { files, originals } = await fixture(home, platform);
    const originalBytes = Object.fromEntries(await Promise.all(SOURCES.map(async (source) =>
      [source, await fs.readFile(files[source], "utf8")])));
    const now = () => new Date("2026-10-18T16:05:00Z");
    const first = await run(home, ["init", "--yes", "--skip-import"], { platform, now });
    assert.equal(first.code, 0, first.stderr);
    assert.equal((first.stdout.match(/: add \|/gu) ?? []).length, 6);
    for (const source of SOURCES) {
      const url = `${BASE}/mcp/${encodeURIComponent(TOKEN)}-${source}`;
      const text = await fs.readFile(files[source], "utf8");
      if (source === "codex") {
        assert.ok(text.startsWith(originals.codex + "\r\n"));
        assert.ok(text.includes(`url = "${url}"`));
        assert.equal(text.split("# >>> jinai-memory").length - 1, 1);
      } else {
        const config = JSON.parse(text);
        const key = source === "vscode" ? "servers" : "mcpServers";
        const expected = source === "cursor" ? { url } : source === "gemini" ? { httpUrl: url }
          : source === "copilot-cli" ? { type: "http", url, tools: ["*"] } : { type: "http", url };
        assert.deepEqual(config[key]["jinai-memory"], expected);
        delete config[key]["jinai-memory"];
        assert.deepEqual(config, originals[source]);
        assert.deepEqual(Object.keys(config), Object.keys(originals[source]));
        assert.ok(text.endsWith("\n"));
      }
      const saved = await backups(files[source]);
      assert.equal(saved.length, 1);
      assert.match(saved[0], /\.jinai-backup-\d{14}$/u);
      assert.equal(await fs.readFile(path.join(path.dirname(files[source]), saved[0]), "utf8"), originalBytes[source]);
    }
    const stateFile = path.join(home, ".jinai-memory", "installs.json");
    const stateText = await fs.readFile(stateFile, "utf8");
    hidden(stateText);
    assert.ok(!stateText.includes("/mcp/"));
    const state = JSON.parse(stateText);
    assert.equal(state.installs.length, 6);
    assert.ok(state.installs.every((entry) => entry.existed && entry.backup && entry.installedAt));
    const beforeAgain = await snapshot(home);
    const second = await run(home, ["init", "--yes", "--skip-import"], { platform, now });
    assert.equal(second.code, 0, second.stderr);
    assert.equal((second.stdout.match(/already connected/gu) ?? []).length, 6);
    assert.deepEqual(await snapshot(home), beforeAgain);
    const removed = await run(home, ["remove", "--yes"], { platform, now });
    assert.equal(removed.code, 0, removed.stderr);
    for (const source of SOURCES) {
      const text = await fs.readFile(files[source], "utf8");
      if (source === "codex") assert.equal(text, originals.codex);
      else assert.deepEqual(JSON.parse(text), originals[source]);
      assert.equal((await backups(files[source])).length, 2, "Removal must also back up without overwriting");
    }
    await assert.rejects(fs.readFile(stateFile), { code: "ENOENT" });
  });

  test(`${platform}: commented JSON and dry runs never change any bytes`, async (t) => {
    const home = await temporary(t);
    const files = locations(home, platform);
    await put(files.cursor, '{\r\n  // A fictional comment\r\n  "mcpServers": {}\r\n}\r\n');
    await put(files.vscode, '{"inputs":[],"servers":{}}\n');
    const before = await snapshot(home);
    const dry = await run(home, ["init", "--dry-run", "--skip-import"], { platform });
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(await snapshot(home), before);
    const applied = await run(home, ["init", "--yes", "--only", "cursor", "--skip-import"], { platform });
    assert.equal(applied.code, 0, applied.stderr);
    assert.match(applied.stdout, /Cursor: skip.*JSON has comments or is invalid; add\/remove manually/u);
    assert.deepEqual(await snapshot(home), before);
  });

  test(`${platform}: rejected token arguments and non-TTY missing tokens write nothing`, async (t) => {
    const home = await temporary(t);
    await fs.mkdir(path.join(home, ".cursor"));
    const before = await snapshot(home);
    for (const arg of [["--token", TOKEN], [`--token=${TOKEN}`]]) {
      for (const command of ["init", "remove", "import"]) {
        const result = await run(home, [command, "--yes", ...arg]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /JINAI_MEMORY_TOKEN/u);
        assert.deepEqual(await snapshot(home), before);
      }
    }
    const missing = await run(home, ["init", "--yes", "--skip-import"], { env: {}, platform });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Set JINAI_MEMORY_TOKEN/u);
    assert.deepEqual(await snapshot(home), before);
  });
}

test("new files and newly created JSON sections are removed without losing unrelated keys", async (t) => {
  const home = await temporary(t);
  const files = locations(home, "win32");
  await fs.mkdir(path.join(home, ".claude"));
  await fs.mkdir(path.dirname(files.cursor));
  await fs.mkdir(path.dirname(files.codex));
  await put(files.vscode, '{"inputs":[],"feature":true}\n');
  const result = await run(home, ["init", "--yes", "--skip-import"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await backups(files.vscode)).length, 1);
  assert.equal((await backups(files.cursor)).length, 0);
  const removed = await run(home, ["remove", "--yes"], { env: {} });
  assert.equal(removed.code, 0, removed.stderr);
  for (const source of ["claude-code", "cursor", "codex"]) {
    await assert.rejects(fs.readFile(files[source]), { code: "ENOENT" });
  }
  assert.deepEqual(JSON.parse(await fs.readFile(files.vscode, "utf8")), { inputs: [], feature: true });
});

test("updates replace only the entry, preserve order and remain removable", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32").cursor;
  const previous = { mcpServers: { first: {}, "jinai-memory": { url: "https://example.invalid/old" }, last: {} }, extra: 1 };
  await put(file, JSON.stringify(previous));
  const updated = await run(home, ["init", "--yes", "--only", "cursor", "--skip-import"]);
  assert.equal(updated.code, 0, updated.stderr);
  assert.match(updated.stdout, /Cursor: update/u);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, "utf8")).mcpServers), ["first", "jinai-memory", "last"]);
  assert.equal((await backups(file)).length, 1);
  const removed = await run(home, ["remove", "--yes"]);
  assert.equal(removed.code, 0, removed.stderr);
  delete previous.mcpServers["jinai-memory"];
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), previous);
});

test("unowned JSON connections and unmanaged or ambiguous TOML remain untouched", async (t) => {
  const home = await temporary(t);
  const files = locations(home, "win32");
  await put(files.cursor, JSON.stringify({ mcpServers: { "jinai-memory": { url: `${BASE}/mcp/${encodeURIComponent(TOKEN)}-cursor` } } }));
  for (const toml of [
    '[mcp_servers.jinai-memory]\nurl = "https://example.invalid/manual"\n',
    '[mcp_servers."jinai-memory"]\nurl = "https://example.invalid/manual"\n',
    "# >>> jinai-memory\nbroken = true\n",
    "# >>> jinai-memory\n# <<< jinai-memory\n# >>> jinai-memory\n# <<< jinai-memory\n",
  ]) {
    await put(files.codex, toml);
    const before = await snapshot(home);
    const result = await run(home, ["init", "--yes", "--skip-import"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Codex CLI: skip/u);
    const removed = await run(home, ["remove", "--yes"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(await snapshot(home), before);
  }
});

test("managed TOML updates touch only the marked interval and remove it byte-for-byte", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32").codex;
  const prefix = 'model = "fictional"\n\n';
  const suffix = '\n[mcp_servers.other]\ncommand = "fictional"\n';
  await put(file, `${prefix}# >>> jinai-memory\n[mcp_servers.jinai-memory]\nurl = "https://example.invalid/old"\n# <<< jinai-memory\n${suffix}`);
  const updated = await run(home, ["init", "--yes", "--skip-import"]);
  assert.equal(updated.code, 0, updated.stderr);
  assert.match(updated.stdout, /Codex CLI: update/u);
  const text = await fs.readFile(file, "utf8");
  assert.ok(text.startsWith(prefix) && text.endsWith(suffix));
  assert.equal((await run(home, ["remove", "--yes"])).code, 0);
  assert.equal(await fs.readFile(file, "utf8"), prefix + suffix);
});

test("--home isolates all external config variables, and --only never writes other tools", async (t) => {
  const home = await temporary(t);
  const outside = await temporary(t);
  const { files } = await fixture(home, "win32");
  const env = { JINAI_MEMORY_TOKEN: TOKEN, APPDATA: outside, XDG_CONFIG_HOME: outside, COPILOT_HOME: outside };
  await put(path.join(outside, "mcp-config.json"), "external bytes");
  const before = await snapshot(home);
  const external = await snapshot(outside);
  const result = await run(home, ["init", "--yes", "--only", "cursor,vscode", "--server", "https://example.invalid/base///", "--skip-import"], { env });
  assert.equal(result.code, 0, result.stderr);
  for (const source of ["cursor", "vscode"]) {
    const config = JSON.parse(await fs.readFile(files[source], "utf8"));
    assert.equal(config[source === "cursor" ? "mcpServers" : "servers"]["jinai-memory"].url,
      `https://example.invalid/base/mcp/${encodeURIComponent(TOKEN)}-${source}`);
  }
  const after = await snapshot(home);
  for (const source of ["claude-code", "copilot-cli", "codex", "gemini"]) {
    assert.equal(after[path.relative(home, files[source])], before[path.relative(home, files[source])]);
  }
  assert.deepEqual(await snapshot(outside), external);
  assert.equal((await run(home, ["remove", "--yes", "--only", "cursor"])).code, 0);
  const state = JSON.parse(await fs.readFile(path.join(home, ".jinai-memory", "installs.json"), "utf8"));
  assert.deepEqual(state.installs.map((entry) => entry.tool), ["vscode"]);
});

test("native configuration-home variables work when no --home override was supplied", async (t) => {
  const home = await temporary(t);
  const external = await temporary(t);
  await fs.mkdir(path.join(external, "Code", "User"), { recursive: true });
  for (const platform of ["win32", "linux"]) {
    const tools = await detectTools({
      home, platform, env: { APPDATA: external, XDG_CONFIG_HOME: external, COPILOT_HOME: external },
    });
    assert.equal(tools.find((tool) => tool.source === "vscode").found, true);
    assert.equal(tools.find((tool) => tool.source === "vscode").file, path.join(external, "Code", "User", "mcp.json"));
    assert.equal(tools.find((tool) => tool.source === "copilot-cli").found, true);
  }
});

test("invalid JSON structures, invalid servers, corrupted records and exceptions fail without leaking secrets", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32").cursor;
  for (const contents of ["null", "[]", '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":1}']) {
    await put(file, contents);
    const before = await snapshot(home);
    const result = await run(home, ["init", "--yes", "--skip-import"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /unsupported JSON structure/u);
    assert.deepEqual(await snapshot(home), before);
  }
  await put(file, "{}");
  const before = await snapshot(home);
  for (const server of [`https://${encodeURIComponent(TOKEN)}@example.invalid`, "file:fictional", "not a URL"]) {
    const result = await run(home, ["init", "--yes", "--skip-import", "--server", server]);
    assert.equal(result.code, 1);
    assert.deepEqual(await snapshot(home), before);
  }
  const failure = await run(home, ["init", "--yes", "--skip-import"], {
    io: { ...fs, lstat: async () => { throw new Error(`PRIVATE ${TOKEN} ${encodeURIComponent(TOKEN)}`); } },
  });
  assert.equal(failure.code, 1);
  assert.ok(!failure.stderr.includes("PRIVATE"));
  const state = path.join(home, ".jinai-memory", "installs.json");
  await put(state, `{"private":"${TOKEN}"`);
  const corrupt = await snapshot(home);
  assert.equal((await run(home, ["init", "--yes", "--skip-import"])).code, 1);
  assert.deepEqual(await snapshot(home), corrupt);
});

test("non-TTY confirmation refuses writes, and removal skips newly unreadable JSON for a retry", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32").cursor;
  await put(file, "{}");
  const before = await snapshot(home);
  const declined = await run(home, ["init", "--skip-import"]);
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /Confirmation requires a TTY/u);
  assert.deepEqual(await snapshot(home), before);
  assert.equal((await run(home, ["init", "--yes", "--skip-import"])).code, 0);
  await fs.writeFile(file, `// ${TOKEN}\n{}`);
  const changed = await snapshot(home);
  const removed = await run(home, ["remove", "--yes"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /Cursor: skip/u);
  assert.deepEqual(await snapshot(home), changed, "Keep the ownership record for a later removal retry");
});

test("failed install-record persistence rolls back configuration and preserves the backup", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32").cursor;
  await put(file, '{"other":true}');
  const io = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(to) === "installs.json") throw new Error(`PRIVATE ${TOKEN}`);
      return fs.rename(from, to);
    },
  };
  const result = await run(home, ["init", "--yes", "--skip-import"], { io });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rolled back/u);
  assert.equal(await fs.readFile(file, "utf8"), '{"other":true}');
  assert.equal((await backups(file)).length, 1);
  assert.ok(!Object.keys(await snapshot(home)).some((name) => name.endsWith(".tmp")));
});

test("removal preserves changed connections and unrelated edits, retaining skipped ownership records", async (t) => {
  const home = await temporary(t);
  const { files } = await fixture(home, "win32");
  assert.equal((await run(home, ["init", "--yes", "--skip-import"])).code, 0);
  const cursor = JSON.parse(await fs.readFile(files.cursor, "utf8"));
  cursor.mcpServers["jinai-memory"].url = "https://example.invalid/user-replacement";
  await fs.writeFile(files.cursor, JSON.stringify(cursor));
  const codex = await fs.readFile(files.codex, "utf8");
  await fs.writeFile(files.codex, codex.replace("[mcp_servers.jinai-memory]", "[mcp_servers.jinai-memory]\r\n# User changed the managed block."));
  const vscode = JSON.parse(await fs.readFile(files.vscode, "utf8"));
  vscode.servers.later = { command: "fictional-later" };
  await fs.writeFile(files.vscode, JSON.stringify(vscode));
  const before = {
    cursor: await fs.readFile(files.cursor, "utf8"),
    codex: await fs.readFile(files.codex, "utf8"),
  };
  const result = await run(home, ["remove", "--yes"], { env: {} });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Cursor: skip.*changed since installation/u);
  assert.match(result.stdout, /Codex CLI: skip.*changed since installation/u);
  assert.equal(await fs.readFile(files.cursor, "utf8"), before.cursor);
  assert.equal(await fs.readFile(files.codex, "utf8"), before.codex);
  const remaining = JSON.parse(await fs.readFile(path.join(home, ".jinai-memory", "installs.json"), "utf8"));
  hidden(JSON.stringify(remaining));
  assert.deepEqual(remaining.installs.map((entry) => entry.tool).sort(), ["codex", "cursor"]);
  delete vscode.servers["jinai-memory"];
  assert.deepEqual(JSON.parse(await fs.readFile(files.vscode, "utf8")), vscode);
});

test("JSON entry key reordering is not mistaken for a changed connection", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32")["claude-code"];
  await put(file, '{"projects":{}}');
  assert.equal((await run(home, ["init", "--yes", "--skip-import"])).code, 0);
  const config = JSON.parse(await fs.readFile(file, "utf8"));
  const { url, type } = config.mcpServers["jinai-memory"];
  config.mcpServers["jinai-memory"] = { url, type };
  await fs.writeFile(file, JSON.stringify(config));
  const result = await run(home, ["remove", "--yes"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { projects: {} });
});

test("Codex removal preserves every outside byte after the user inserts lines before its block", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32").codex;
  await put(file, 'model = "fictional"');
  assert.equal((await run(home, ["init", "--yes", "--skip-import"])).code, 0);
  const installed = await fs.readFile(file, "utf8");
  const changed = installed.replace("# >>> jinai-memory", '# A later user comment.\n# >>> jinai-memory');
  await fs.writeFile(file, changed);
  const block = /^# >>> jinai-memory\n[\s\S]*?^# <<< jinai-memory\n/mu;
  const expected = changed.replace(block, "");
  assert.equal((await run(home, ["remove", "--yes"])).code, 0);
  assert.equal(await fs.readFile(file, "utf8"), expected);
});

test("symbolic-link files, config directories and install records are not followed", async (t) => {
  const home = await temporary(t);
  const external = await temporary(t);
  await put(path.join(external, "mcp.json"), '{"external":true}');
  const directory = path.join(home, ".cursor");
  await fs.symlink(external, directory, process.platform === "win32" ? "junction" : "dir");
  const before = await snapshot(external);
  const result = await run(home, ["init", "--yes", "--skip-import"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Cursor: skip/u);
  assert.deepEqual(await snapshot(external), before);
  await fs.unlink(directory);
  await fs.symlink(external, path.join(home, ".jinai-memory"), process.platform === "win32" ? "junction" : "dir");
  const blocked = await run(home, ["init", "--yes", "--skip-import"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /Could not read installs.json safely/u);
  assert.deepEqual(await snapshot(external), before);
});

test("confirmation accepts only y and declines safely on an empty answer or EOF", async (t) => {
  for (const answer of ["n\n", "\n", "yes\n", "", "Y\n"]) {
    const home = await temporary(t);
    const file = locations(home, "win32").cursor;
    await put(file, "{}");
    const input = new PassThrough();
    input.isTTY = true;
    const output = [];
    const before = await snapshot(home);
    const result = await run(home, ["init", "--skip-import"], {
      stdin: input,
      stdout: { write: (text) => {
        output.push(text);
        if (text.includes("Proceed?")) queueMicrotask(() => input.end(answer));
      } },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(output.join(""), /Proceed\? \[y\/N\]/u);
    if (answer === "Y\n") assert.ok(JSON.parse(await fs.readFile(file, "utf8")).mcpServers["jinai-memory"]);
    else {
      assert.match(result.stdout, /Cancelled/u);
      assert.deepEqual(await snapshot(home), before);
    }
    input.destroy();
  }
});

test("configuration changes after planning and partial temporary writes fail without replacing the user's file", async (t) => {
  const home = await temporary(t);
  const file = locations(home, "win32").cursor;
  await put(file, "{}");
  let reads = 0;
  const changed = await run(home, ["init", "--yes", "--skip-import"], {
    io: { ...fs, readFile: async (filename, ...args) => {
      if (filename === file && ++reads === 2) await fs.writeFile(file, '{"changed":true}');
      return fs.readFile(filename, ...args);
    } },
  });
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /changed after planning/u);
  assert.equal(await fs.readFile(file, "utf8"), '{"changed":true}');
  assert.equal((await backups(file)).length, 0);
  const failure = await run(home, ["init", "--yes", "--skip-import"], {
    io: { ...fs, writeFile: async (filename, ...args) => {
      if (filename.endsWith(".tmp")) {
        await fs.writeFile(filename, "partial secret bytes", { flag: "wx" });
        throw new Error(`PRIVATE ${TOKEN}`);
      }
      return fs.writeFile(filename, ...args);
    } },
  });
  assert.equal(failure.code, 1);
  assert.equal(await fs.readFile(file, "utf8"), '{"changed":true}');
  assert.ok(!Object.keys(await snapshot(home)).some((name) => name.endsWith(".tmp")));
  await assert.rejects(fs.readFile(path.join(home, ".jinai-memory", "installs.json")), { code: "ENOENT" });
});

test("malformed Unicode tokens are rejected without echoing raw exception contents", async (t) => {
  const home = await temporary(t);
  const secret = "fictional-malformed-\uD800";
  const output = [];
  const code = await main(["init", "--yes", "--home", home], {
    home, env: { JINAI_MEMORY_TOKEN: secret },
    log: (text) => output.push(text), error: (text) => output.push(text),
  });
  assert.equal(code, 1);
  assert.ok(!output.join("\n").includes(secret));
  assert.deepEqual(await snapshot(home), {});
});

test("hidden TTY token input never echoes and restores raw mode on success and cancellation", async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough();
    input.isTTY = true;
    input.isRaw = false;
    const modes = [];
    input.setRawMode = (raw) => { modes.push(raw); input.isRaw = raw; };
    let output = "";
    const pending = readHiddenToken(input, { write: (text) => { output += text; } });
    queueMicrotask(() => input.write(cancel ? `${TOKEN}\u0003` : `${TOKEN}x\u007f\r`));
    if (cancel) await assert.rejects(pending, /cancelled/u);
    else assert.equal(await pending, TOKEN);
    hidden(output);
    assert.deepEqual(modes, [true, false]);
    assert.equal(input.listenerCount("data"), 0);
    input.destroy();
  }
});

test("clipboard commands receive the URL only on stdin, support fallback and never copy in dry runs", async (t) => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const home = await temporary(t);
    const calls = [];
    const exec = async (command, args, input) => {
      calls.push({ command, args, input });
      return command !== "wl-copy";
    };
    const result = await run(home, ["init", "--yes", "--copy", "claude", "--skip-import"], { platform, exec });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Connector URL copied for claude/u);
    assert.deepEqual(calls.map((call) => call.command),
      platform === "win32" ? ["clip"] : platform === "darwin" ? ["pbcopy"] : ["wl-copy", "xclip"]);
    for (const call of calls) {
      assert.equal(call.input, `${BASE}/mcp/${encodeURIComponent(TOKEN)}-claude`);
      hidden(JSON.stringify(call.args));
    }
    assert.deepEqual(calls.at(-1).args, platform === "linux" ? ["-selection", "clipboard"] : []);
    calls.length = 0;
    assert.equal((await run(home, ["init", "--dry-run", "--copy", "chatgpt", "--skip-import"], { platform, exec })).code, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(await snapshot(home), {});
  }
  const home = await temporary(t);
  const failed = await run(home, ["init", "--yes", "--copy", "chatgpt", "--skip-import"], {
    exec: () => { throw new Error(`PRIVATE ${TOKEN}`); },
  });
  assert.equal(failed.code, 0);
  assert.match(failed.stdout, /Could not copy the connector URL/u);
});

test("init invokes only an import dry run, while import forwards every remaining argument unchanged", async (t) => {
  const home = await temporary(t);
  const calls = [];
  const importMain = async (args, context) => {
    calls.push({ args, context });
    return { failed: 0 };
  };
  assert.equal((await run(home, ["init", "--yes"], { importMain })).code, 0);
  assert.deepEqual(calls[0].args, ["--home", home]);
  assert.equal(calls[0].context.home, home);
  assert.equal(calls[0].context.env.JINAI_MEMORY_TOKEN, TOKEN);
  const args = ["--yes", "--include", "fictional.md", "--server", "http://127.0.0.1:1"];
  assert.equal((await run(home, ["import", ...args], { importMain })).code, 0);
  assert.deepEqual(calls[1].args, [...args, "--home", home]);
  const real = await run(home, ["init", "--yes"]);
  assert.equal(real.code, 0, real.stderr);
  assert.match(real.stdout, /Existing memory preview \(dry run only\)/u);
  for (const label of ["skills", "memory files", "CLAUDE.md sections", "Claude Code sessions", "secrets skipped"]) {
    assert.ok(real.stdout.includes(label));
  }
  assert.match(real.stdout, /To send: npx github:yukeidaro\/jinai-memory import --yes/u);
  assert.deepEqual(await snapshot(home), {});
});

test("CLI child processes support init/remove/help and reject token arguments without leaking", async (t) => {
  const home = await temporary(t);
  await fs.mkdir(path.join(home, ".cursor"));
  const cli = (args, env = {}) => {
    const result = spawnSync(process.execPath, [BIN, ...args, "--home", home], {
      env: { SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home, ...env },
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.ifError(result.error);
    hidden(result.stdout + result.stderr);
    return result;
  };
  const before = await snapshot(home);
  const denied = cli(["init", "--yes", "--token", TOKEN]);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /JINAI_MEMORY_TOKEN/u);
  assert.deepEqual(await snapshot(home), before);
  const missing = cli(["init", "--yes", "--skip-import"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(await snapshot(home), before);
  const installed = cli(["init", "--yes", "--skip-import"], { JINAI_MEMORY_TOKEN: TOKEN });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Cursor: add/u);
  assert.equal(cli(["remove", "--yes"]).status, 0);
  const help = cli(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: npx github:yukeidaro\/jinai-memory/u);
});

test("CLI walkthrough: dry-run, init with memory preview, then remove in a fictional home", async (t) => {
  const home = await temporary(t);
  const { files, originals } = await fixture(home, process.platform);
  await put(path.join(home, ".claude", "CLAUDE.md"),
    "## Fictional preferences\nUse short answers for this fictional demonstration.\n");
  const cli = (args) => {
    const command = [...args, "--home", home];
    const result = spawnSync(process.execPath, [BIN, ...command], {
      env: { SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home, JINAI_MEMORY_TOKEN: TOKEN },
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.ifError(result.error);
    hidden(result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stderr);
    t.diagnostic(`node bin\\jinai-memory.mjs ${command.join(" ")}\n${result.stdout.trimEnd()}`);
    return result;
  };
  const before = await snapshot(home);
  const dry = cli(["init", "--dry-run"]);
  assert.match(dry.stdout, /Dry run: no files written/u);
  assert.deepEqual(await snapshot(home), before);
  const installed = cli(["init", "--yes"]);
  assert.equal((installed.stdout.match(/: add \|/gu) ?? []).length, 6);
  assert.match(installed.stdout, /Dry run: nothing sent/u);
  assert.match(installed.stdout, /CLAUDE.md sections\s+1/u);
  assert.match(installed.stdout, /Claude Code sessions\s+0/u);
  const state = await fs.readFile(path.join(home, ".jinai-memory", "installs.json"), "utf8");
  hidden(state);
  const removed = cli(["remove", "--yes"]);
  assert.equal((removed.stdout.match(/: remove \|/gu) ?? []).length, 6);
  for (const source of SOURCES) {
    const text = await fs.readFile(files[source], "utf8");
    if (source === "codex") assert.equal(text, originals.codex);
    else assert.deepEqual(JSON.parse(text), originals[source]);
  }
  await assert.rejects(fs.readFile(path.join(home, ".jinai-memory", "installs.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(home, ".claude", "CLAUDE.md"), "utf8"),
    "## Fictional preferences\nUse short answers for this fictional demonstration.\n");
});
