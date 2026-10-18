import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { main as runImport } from "../scripts/import.mjs";
import { ImportError, importEndpoint } from "./importer.js";

const SERVER = "https://jinai-memory.onrender.com";
const NAME = "jinai-memory";
const SOURCES = ["claude-code", "cursor", "vscode", "copilot-cli", "codex", "gemini"];
const MANUAL = ["claude", "chatgpt"];
const START = "# >>> jinai-memory";
const END = "# <<< jinai-memory";
const HELP = `Usage: npx github:yukeidaro/jinai-memory <command> [options]

  init                  Connect detected AI tools; preview existing memory without sending
  remove                Remove only connections installed by this CLI (or its Codex markers)
  import [options]      Forward options to the memory importer (dry run by default)
  help                  Show this help

  --home <directory>    Use an isolated home, ignoring external config-home variables
  --yes                 Skip confirmation (init never sends memories)
  --dry-run             Show plans without writing files or copying to the clipboard
  --only <sources>      Comma-separated: ${[...SOURCES, ...MANUAL].join(",")}
  --server <url>        HTTP(S) server (or JINAI_MEMORY_URL)
  --copy <claude|chatgpt> Copy a manual connector URL without displaying it (init only)
  --skip-import         Skip the final memory preview (init only)
  --help                Show this help

Set JINAI_MEMORY_TOKEN in the environment, or enter it at the hidden TTY prompt.
Tokens are never accepted as arguments. Backups are saved beside changed files.
Unparseable JSON is left untouched; add the connection manually in that case.`;

class InstallerError extends Error {}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fingerprint(value) {
  const text = JSON.stringify(value, (_key, item) => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash("sha256").update(text).digest("hex");
}

function options(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args, strict: true, allowPositionals: false,
      options: {
        home: { type: "string" }, yes: { type: "boolean" }, "dry-run": { type: "boolean" },
        only: { type: "string" }, server: { type: "string" }, copy: { type: "string" },
        "skip-import": { type: "boolean" }, help: { type: "boolean" },
      },
    }));
  } catch {
    throw new InstallerError("Invalid arguments. Use help. Pass tokens only through JINAI_MEMORY_TOKEN, never --token.");
  }
  const only = values.only === undefined ? [...SOURCES, ...MANUAL] : values.only.split(",");
  if (!only.length || only.some((source) => ![...SOURCES, ...MANUAL].includes(source))) {
    throw new InstallerError("Unknown --only source. Use help for the supported source names.");
  }
  if (values.copy !== undefined && !MANUAL.includes(values.copy)) {
    throw new InstallerError("--copy accepts only claude or chatgpt.");
  }
  if (values.home !== undefined && !values.home.trim()) {
    throw new InstallerError("--home requires a directory.");
  }
  return { ...values, only };
}

async function exists(filename, directory, io) {
  try {
    const info = await io.lstat(filename);
    return directory ? info.isDirectory() && !info.isSymbolicLink() : info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw new InstallerError("Could not inspect an AI tool's configuration location.");
  }
}

export async function detectTools({
  home, env = {}, platform = process.platform, io = fs, isolated = false,
}) {
  const configOverride = !isolated && (platform === "win32" ? env.APPDATA
    : platform === "darwin" ? undefined : env.XDG_CONFIG_HOME);
  const cfg = configOverride || (platform === "win32" ? path.join(home, "AppData", "Roaming")
    : platform === "darwin" ? path.join(home, "Library", "Application Support") : path.join(home, ".config"));
  const copilot = !isolated && env.COPILOT_HOME || path.join(home, ".copilot");
  const tools = [
    { source: "claude-code", label: "Claude Code", file: path.join(home, ".claude.json"), key: "mcpServers" },
    { source: "cursor", label: "Cursor", file: path.join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    { source: "vscode", label: "VS Code / Copilot", file: path.join(cfg, "Code", "User", "mcp.json"), key: "servers" },
    { source: "copilot-cli", label: "Copilot CLI", file: path.join(copilot, "mcp-config.json"), key: "mcpServers" },
    { source: "codex", label: "Codex CLI", file: path.join(home, ".codex", "config.toml") },
    { source: "gemini", label: "Gemini CLI", file: path.join(home, ".gemini", "settings.json"), key: "mcpServers" },
  ];
  for (const tool of tools) {
    tool.file = path.resolve(tool.file);
    tool.root = path.resolve(tool.source === "vscode" && configOverride ? cfg
      : tool.source === "copilot-cli" && !isolated && env.COPILOT_HOME ? copilot : home);
    tool.found = tool.source === "copilot-cli" && !isolated && Boolean(env.COPILOT_HOME) || (tool.source === "claude-code"
      ? await exists(tool.file, false, io) || await exists(path.join(home, ".claude"), true, io)
      : await exists(path.dirname(tool.file), true, io));
  }
  return tools;
}

// Raw input avoids readline's echo, including when terminal output is captured.
export async function readHiddenToken(input, output) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new InstallerError("No token available. Set JINAI_MEMORY_TOKEN or run init in a TTY to enter it privately.");
  }
  output.write("JINAI_MEMORY_TOKEN (hidden): ");
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  let token = "";
  try {
    input.setRawMode(true);
    input.resume();
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        input.removeListener("data", data);
        input.removeListener("error", failed);
        input.removeListener("end", ended);
        input.removeListener("close", ended);
      };
      const failed = () => {
        cleanup();
        reject(new InstallerError("Could not read the hidden token. Nothing was written."));
      };
      const ended = () => {
        cleanup();
        reject(new InstallerError("Token input cancelled. Nothing was written."));
      };
      const data = (chunk) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\u0003" || char === "\u0004" || char === "\u001b") return ended();
          if (char === "\r" || char === "\n") {
            cleanup();
            resolve(token);
            return;
          }
          if (char === "\b" || char === "\u007f") token = Array.from(token).slice(0, -1).join("");
          else if (!/[\p{Cc}\p{Cf}]/u.test(char)) token += char;
        }
      };
      input.on("data", data);
      input.once("error", failed);
      input.once("end", ended);
      input.once("close", ended);
    });
  } finally {
    input.setRawMode(Boolean(wasRaw));
    if (wasPaused) input.pause();
    output.write("\n");
  }
}

async function confirm(input, output) {
  if (!input.isTTY) {
    throw new InstallerError("Confirmation requires a TTY. Review with --dry-run, or use --yes to proceed.");
  }
  const prompt = createInterface({ input, output, terminal: false });
  const controller = new AbortController();
  prompt.once("close", () => controller.abort());
  try {
    return /^y$/iu.test((await prompt.question("Proceed? [y/N] ", { signal: controller.signal })).trim());
  } catch (error) {
    if (error.name === "AbortError") return false;
    throw new InstallerError("Could not read confirmation. Nothing was written.");
  } finally {
    prompt.close();
  }
}

export async function execute(command, args, input) {
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    let inputFailed = false;
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0 && !inputFailed); });
    child.stdin.on("error", () => { inputFailed = true; });
    child.stdin.end(input);
  });
}

async function checkParents(filename, root, io) {
  let directory = path.dirname(filename);
  while (true) {
    try {
      const info = await io.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new InstallerError("Configuration parent is not a regular directory.");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (directory === root) return;
    const parent = path.dirname(directory);
    if (parent === directory) throw new InstallerError("Configuration is outside its expected root.");
    directory = parent;
  }
}

async function read(filename, io, root) {
  await checkParents(filename, root, io);
  try {
    const info = await io.lstat(filename);
    if (info.isSymbolicLink() || !info.isFile()) throw new InstallerError("Not a regular configuration file.");
    const bytes = await io.readFile(filename);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new InstallerError("Configuration is not UTF-8.");
    return { text, mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { text: undefined, mode: 0o600 };
    throw error;
  }
}

async function loadInstalls(filename, io) {
  let original;
  try {
    original = await read(filename, io, path.dirname(path.dirname(filename)));
    if (original.text === undefined) return { original, installs: [] };
    const state = JSON.parse(original.text);
    const allowed = ["tool", "file", "existed", "backup", "installedAt", "createdSection",
      "separator", "prefixFingerprint", "fingerprint"];
    if (!object(state) || state.version !== 1 || !Array.isArray(state.installs) ||
        Object.keys(state).some((key) => !["version", "installs"].includes(key)) ||
        state.installs.some((entry) => !object(entry) || !SOURCES.includes(entry.tool) ||
          typeof entry.file !== "string" || !path.isAbsolute(entry.file) ||
          typeof entry.existed !== "boolean" ||
          entry.backup !== null && typeof entry.backup !== "string" ||
          typeof entry.installedAt !== "string" || typeof entry.createdSection !== "boolean" ||
          typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint) ||
          entry.prefixFingerprint !== null && (typeof entry.prefixFingerprint !== "string" ||
            !/^[a-f0-9]{64}$/u.test(entry.prefixFingerprint)) ||
          !["", "\n", "\r\n"].includes(entry.separator) ||
          Object.keys(entry).some((key) => !allowed.includes(key))) ||
        new Set(state.installs.map((entry) => entry.file)).size !== state.installs.length) {
      throw new InstallerError("Invalid install record.");
    }
    return { original, installs: state.installs };
  } catch {
    throw new InstallerError("Could not read installs.json safely. Restore or repair it before making changes.");
  }
}

function connection(source, url) {
  if (source === "cursor") return { url };
  if (source === "gemini") return { httpUrl: url };
  if (source === "copilot-cli") return { type: "http", url, tools: ["*"] };
  return { type: "http", url };
}

function tomlPlan(item, url, record, removing) {
  const text = item.original.text ?? "";
  const starts = text.split(/\r?\n/u).filter((line) => line === START).length;
  const ends = text.split(/\r?\n/u).filter((line) => line === END).length;
  const block = /^# >>> jinai-memory\r?\n[\s\S]*?^# <<< jinai-memory(?:\r?\n|$)/mu.exec(text);
  if ((starts || ends) && (starts !== 1 || ends !== 1 || !block)) {
    return { ...item, action: "skip", reason: "ambiguous Codex markers; edit manually" };
  }
  const outside = block ? text.slice(0, block.index) + text.slice(block.index + block[0].length) : text;
  if (/^\s*\[\[?\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:jinai-memory|"jinai-memory"|'jinai-memory')\s*(?:\.|\])/mu.test(outside)) {
    return { ...item, action: "skip", reason: "unmanaged Codex entry; edit manually" };
  }
  item.separator = record?.separator ?? "";
  item.prefixFingerprint = record?.prefixFingerprint ?? null;
  if (removing) {
    if (!block) return { ...item, action: "already removed", reason: "no managed Codex block" };
    if (record && record.fingerprint !== fingerprint(block[0])) {
      return { ...item, action: "skip", reason: "managed block changed since installation; edit manually" };
    }
    const prefix = text.slice(0, block.index);
    const offset = item.separator && prefix.endsWith(item.separator) &&
      item.prefixFingerprint === fingerprint(prefix.slice(0, -item.separator.length))
      ? block.index - item.separator.length : block.index;
    item.next = text.slice(0, offset) + text.slice(block.index + block[0].length);
    return { ...item, action: "remove", deleteFile: record?.existed === false && item.next === "" };
  }
  const eol = block?.[0].includes("\r\n") || !block && text.includes("\r\n") ? "\r\n" : "\n";
  const ending = block && !block[0].endsWith("\n") ? "" : eol;
  const nextBlock = [START, "[mcp_servers.jinai-memory]", `url = ${JSON.stringify(url)}`, END].join(eol) + ending;
  item.fingerprint = fingerprint(nextBlock);
  if (block) {
    item.next = text.slice(0, block.index) + nextBlock + text.slice(block.index + block[0].length);
  } else {
    item.separator = text && !text.endsWith("\n") ? eol : "";
    item.prefixFingerprint = item.separator ? fingerprint(text) : null;
    item.next = text + item.separator + nextBlock;
  }
  return { ...item, action: item.next === text ? "already connected" : block ? "update" : "add" };
}

async function plan(tool, { io, removing, record, url }) {
  let original;
  try {
    original = await read(tool.file, io, tool.root);
  } catch {
    return { ...tool, action: "skip", reason: "unreadable or non-regular file; edit manually" };
  }
  const item = {
    ...tool, original, record, createdSection: record?.createdSection ?? false,
    separator: "", prefixFingerprint: null,
  };
  if (!tool.key) return tomlPlan(item, url, record, removing);
  if (removing && !record) return { ...item, action: "skip", reason: "not installed by this CLI" };
  let config;
  try {
    config = JSON.parse(original.text ?? "{}");
  } catch {
    return { ...item, action: "skip", reason: "JSON has comments or is invalid; add/remove manually" };
  }
  if (!object(config) || Object.hasOwn(config, tool.key) && !object(config[tool.key])) {
    return { ...item, action: "skip", reason: "unsupported JSON structure; edit manually" };
  }
  const sectionExists = Object.hasOwn(config, tool.key);
  const section = sectionExists ? config[tool.key] : {};
  const entryExists = Object.hasOwn(section, NAME);
  if (removing) {
    if (!entryExists) return { ...item, action: "already removed", reason: "entry is absent" };
    if (record.fingerprint !== fingerprint(section[NAME])) {
      return { ...item, action: "skip", reason: "entry changed since installation; edit manually" };
    }
    delete section[NAME];
    if (item.createdSection && !Object.keys(section).length) delete config[tool.key];
    item.deleteFile = record.existed === false && !Object.keys(config).length;
  } else {
    const entry = connection(tool.source, url);
    if (entryExists && isDeepStrictEqual(section[NAME], entry)) return { ...item, action: "already connected" };
    item.createdSection = record?.createdSection ?? !sectionExists;
    item.fingerprint = fingerprint(entry);
    section[NAME] = entry;
    config[tool.key] = section;
  }
  item.next = `${JSON.stringify(config, null, 2)}\n`;
  return { ...item, action: removing ? "remove" : entryExists ? "update" : "add" };
}

async function unchanged(filename, original, io, root) {
  const current = await read(filename, io, root);
  if (current.text !== original.text) {
    throw new InstallerError("A configuration or install record changed after planning. Nothing further was written; rerun to review.");
  }
}

async function atomicWrite(filename, text, mode, io) {
  await io.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let created = false;
  try {
    created = true;
    try {
      await io.writeFile(temporary, text, { flag: "wx", mode });
    } catch (error) {
      if (error.code === "EEXIST") created = false;
      throw error;
    }
    await io.rename(temporary, filename);
    created = false;
  } finally {
    if (created) {
      try {
        await io.unlink(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

async function backup(item, io, now) {
  if (item.original.text === undefined) return null;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const stamp = new Date(now().getTime() + attempt * 1_000).toISOString().replace(/\D/gu, "").slice(0, 14);
    const filename = `${item.file}.jinai-backup-${stamp}`;
    try {
      await io.copyFile(item.file, filename, constants.COPYFILE_EXCL);
      return filename;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new InstallerError("Could not create a unique backup. No configuration was changed.");
}

async function saveInstalls(filename, state, installs, io, hasSecret) {
  await unchanged(filename, state.original, io, path.dirname(path.dirname(filename)));
  if (installs.length) {
    const text = `${JSON.stringify({ version: 1, installs }, null, 2)}\n`;
    if (hasSecret(text)) throw new InstallerError("Install metadata would contain the token. Refusing to record it.");
    await atomicWrite(filename, text, 0o600, io);
    state.original = { text, mode: 0o600 };
  } else if (state.original.text !== undefined) {
    await io.unlink(filename);
    state.original = { text: undefined, mode: 0o600 };
  }
  state.installs = installs;
}

async function apply(item, { state, stateFile, io, now, removing, hasSecret }) {
  if (item.action === "already removed") {
    if (item.record) await saveInstalls(stateFile, state, state.installs.filter((entry) => entry !== item.record), io, hasSecret);
    return;
  }
  if (!["add", "update", "remove"].includes(item.action)) return;
  if ([item.file, stateFile].some(hasSecret)) {
    throw new InstallerError("A configuration path contains the token. Refusing to record it.");
  }
  await unchanged(stateFile, state.original, io, path.dirname(path.dirname(stateFile)));
  await unchanged(item.file, item.original, io, item.root);
  const saved = await backup(item, io, now);
  if (item.deleteFile) await io.unlink(item.file);
  else await atomicWrite(item.file, item.next, item.original.mode, io);
  const installs = state.installs.filter((entry) => entry.tool !== item.source || entry.file !== item.file);
  if (!removing) installs.push({
    tool: item.source, file: item.file,
    existed: item.record?.existed ?? item.original.text !== undefined,
    backup: saved, installedAt: now().toISOString(),
    createdSection: item.createdSection, separator: item.separator,
    prefixFingerprint: item.prefixFingerprint, fingerprint: item.fingerprint,
  });
  try {
    await saveInstalls(stateFile, state, installs, io, hasSecret);
  } catch {
    try {
      await unchanged(item.file, { text: item.deleteFile ? undefined : item.next }, io, item.root);
      if (item.original.text === undefined) await io.unlink(item.file);
      else await atomicWrite(item.file, item.original.text, item.original.mode, io);
    } catch {
      throw new InstallerError("Install record could not be saved and rollback failed. Stop and restore the adjacent backup manually.");
    }
    throw new InstallerError("Install record could not be saved. The configuration change was rolled back; backups were kept.");
  }
}

function privateText(text, token) {
  let result = String(text);
  if (token) {
    let encoded = token;
    try {
      encoded = encodeURIComponent(token);
    } catch {
      // Malformed Unicode has no encoded form; the raw value must still be redacted.
    }
    for (const secret of [...new Set([token, encoded])].sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result.replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === "\n" || char === "\t" ? char : " ");
}

export async function main(args = process.argv.slice(2), {
  env = process.env, home = os.homedir(), platform = process.platform, io = fs,
  stdin = process.stdin, stdout = process.stdout, log = console.log, error = console.error,
  exec = execute, importMain = runImport, now = () => new Date(),
} = {}) {
  let token = env.JINAI_MEMORY_TOKEN;
  const out = (text) => log(privateText(text, token));
  const fail = (text) => error(privateText(text, token));
  try {
    const [command, ...rest] = args;
    if (args.some((arg) => arg === "--token" || arg.startsWith("--token="))) {
      throw new InstallerError("Pass tokens only through JINAI_MEMORY_TOKEN, never --token.");
    }
    if (!command || ["help", "--help", "-h"].includes(command)) {
      out(HELP);
      return 0;
    }
    if (command === "import") {
      const result = await importMain(rest, { env, home, log: out });
      return result.failed ? 1 : 0;
    }
    if (!["init", "remove"].includes(command)) throw new InstallerError("Unknown command. Use help.");
    const values = options(rest);
    if (values.help) {
      out(HELP);
      return 0;
    }
    home = path.resolve(values.home ?? home);
    const removing = command === "remove";
    if (!removing) {
      token = token || await readHiddenToken(stdin, stdout);
      if (!token.trim()) throw new InstallerError("JINAI_MEMORY_TOKEN must not be empty. Nothing was written.");
    }
    const server = (values.server ?? env.JINAI_MEMORY_URL ?? SERVER).replace(/\/+$/u, "");
    if (!removing) importEndpoint(server, token, "claude-code");
    const hasSecret = (text) => Boolean(token && (text.includes(token) || text.includes(encodeURIComponent(token))));
    const tools = await detectTools({ home, env, platform, io, isolated: values.home !== undefined });
    out(`Found: ${tools.filter((tool) => tool.found).map((tool) => `${tool.label} (${tool.source})`).join(", ") || "none"}`);
    out(`Not found: ${tools.filter((tool) => !tool.found).map((tool) => `${tool.label} (${tool.source})`).join(", ") || "none"}`);
    out("Manual: claude.ai / Claude Desktop (claude), ChatGPT (chatgpt)");
    const stateFile = path.join(home, ".jinai-memory", "installs.json");
    const state = await loadInstalls(stateFile, io);
    if (state.original.text && hasSecret(state.original.text)) {
      throw new InstallerError("The install record contains the token. Repair it before making changes.");
    }
    const plans = [];
    for (const tool of tools.filter((tool) => values.only.includes(tool.source))) {
      const record = state.installs.find((entry) => entry.tool === tool.source && entry.file === tool.file);
      const item = !removing && !tool.found
        ? { ...tool, action: "skip", reason: "tool not detected" }
        : await plan(tool, {
          io, removing, record,
          url: removing ? undefined : importEndpoint(server, token, tool.source).href,
        });
      plans.push(item);
      out(`${item.label}: ${item.action} | ${item.file}${item.reason ? ` | ${item.reason}` : ""}`);
    }
    const unmatched = state.installs.filter((entry) => values.only.includes(entry.tool) &&
      !tools.some((tool) => tool.source === entry.tool && tool.file === entry.file));
    for (const entry of unmatched) {
      out(`${entry.tool}: skip | recorded config location differs; rerun with the original configuration-home variables`);
    }
    if (!removing) {
      out("claude.ai / Claude Desktop: claude.ai -> Settings -> Connectors -> Add custom connector.");
      out("Open https://claude.ai/settings/connectors; paste the URL copied with --copy claude. Claude Desktop uses the same account's connector.");
      out("ChatGPT: Settings -> Apps -> Advanced -> Developer mode -> Create; paste the URL copied with --copy chatgpt. Authentication: No authentication.");
    }
    const actionable = plans.filter((item) => ["add", "update", "remove"].includes(item.action) ||
      item.action === "already removed" && item.record);
    if (values["dry-run"]) out("Dry run: no files written and no clipboard changes.");
    else {
      const work = actionable.length || removing && state.original.text !== undefined && !state.installs.length ||
        !removing && values.copy;
      if (work && !values.yes && !await confirm(stdin, stdout)) {
        out("Cancelled. Nothing was written or copied.");
        return 0;
      }
      for (const item of actionable) await apply(item, {
        state, stateFile, io, now, removing,
        hasSecret,
      });
      if (removing && !state.installs.length && state.original.text !== undefined) {
        await saveInstalls(stateFile, state, [], io, hasSecret);
      }
      if (!removing && values.copy) {
        const url = importEndpoint(server, token, values.copy).href;
        const commands = platform === "win32" ? [["clip", []]]
          : platform === "darwin" ? [["pbcopy", []]]
            : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
        let copied = false;
        for (const [command, args] of commands) {
          try {
            copied = await exec(command, args, url);
          } catch {
            copied = false;
          }
          if (copied) break;
        }
        out(copied ? `Connector URL copied for ${values.copy}. It is not displayed.`
          : "Could not copy the connector URL. No clipboard program succeeded.");
      }
    }
    if (!removing && !values["skip-import"]) {
      out("Existing memory preview (dry run only):");
      const result = await importMain(["--home", home], { env, home, log: out });
      if (result.failed) throw new InstallerError("The memory preview failed. No memories were sent.");
      out("To send: npx github:yukeidaro/jinai-memory import --yes");
    }
    return 0;
  } catch (cause) {
    fail(cause instanceof InstallerError || cause instanceof ImportError ? cause.message
      : "Could not complete the operation. No error contents are displayed; inspect permissions and restore an adjacent backup if needed.");
    return 1;
  }
}
