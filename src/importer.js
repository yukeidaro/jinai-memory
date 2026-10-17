import { createHash } from "node:crypto";
import path from "node:path";
import { findSecret } from "./secret-guard.js";

export const IMPORT_TYPES = ["skills", "memory", "claude-md", "copilot"];
const TEXT_LIMIT = 20_000;
const TRUNCATED = "\n\n(truncated)";

export class ImportError extends Error {}

function resolvePath(value) {
  return path.resolve(value.replace(/[\\/]/gu, path.sep));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function firstLine(value) {
  return Array.from(value.trim().split(/[\r\n]/u, 1)[0]).slice(0, 160).join("");
}

function nameWords(name) {
  return name.split("-").map((word) => word.trim()).filter((word) => Array.from(word).length > 2);
}

function importTags(base, words) {
  const tags = [...new Set(base)];
  const specific = [...new Set(words)].filter((word) => !tags.includes(word)).slice(0, 3);
  return [...tags, ...specific].slice(0, 10);
}

function scalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      throw new ImportError("Invalid double-quoted frontmatter value.");
    }
    throw new ImportError("Frontmatter values must be strings.");
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) {
      throw new ImportError("Invalid single-quoted frontmatter value.");
    }
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text.replace(/\s+#.*$/u, "").trim();
}

export function parseFrontmatter(input) {
  const text = input.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = text.split("\n");
  const attributes = Object.create(null);
  if (lines[0] !== "---") return { attributes, body: text, header: "" };
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) throw new ImportError("Frontmatter is missing its closing delimiter.");
  let parent;
  for (let index = 1; index < end; index += 1) {
    const match = /^(\s*)([\w-]+):(?:\s+(.*)|\s*)$/u.exec(lines[index]);
    if (!match) continue;
    const [, indent, key, raw = ""] = match;
    let target = attributes;
    if (indent) {
      if (!parent) continue;
      target = attributes[parent];
    } else {
      parent = undefined;
      if (!raw) {
        attributes[key] = Object.create(null);
        parent = key;
        continue;
      }
    }
    if (/^[|>][-+]?$/u.test(raw)) {
      const block = [];
      while (index + 1 < end && (
        !lines[index + 1].trim() ||
        /^\s/u.test(lines[index + 1]) && lines[index + 1].search(/\S/u) > indent.length
      )) {
        block.push(lines[++index].trim());
      }
      target[key] = block.join(raw.startsWith(">") ? " " : "\n");
    } else {
      target[key] = scalar(raw);
    }
  }
  return {
    attributes,
    body: lines.slice(end + 1).join("\n").trim(),
    header: lines.slice(0, end + 1).join("\n"),
  };
}

function textAttribute(attributes, key, fallback) {
  return typeof attributes[key] === "string" && attributes[key].trim()
    ? attributes[key].trim() : fallback;
}

export function splitInstructions(body) {
  const sections = [];
  let heading = "";
  let lines = [];
  let fence;
  const finish = () => {
    const text = lines.join("\n").trim();
    if (text || heading) sections.push({ heading, text });
    lines = [];
  };
  for (const line of body.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] &&
          marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1];
    } else {
      const match = /^##[ \t]+(.+?)\s*$/u.exec(line);
      if (match) {
        finish();
        heading = match[1].replace(/[ \t]+#+[ \t]*$/u, "").trim();
        continue;
      }
    }
    lines.push(line);
  }
  finish();
  if (!sections.length) sections.push({ heading: "", text: "" });
  return sections;
}

export async function discoverFiles({ home, include = [], only = IMPORT_TYPES, io }) {
  const root = resolvePath(home);
  const files = [];
  const seen = new Set();
  async function directories(directory) {
    try {
      return (await io.readdir(directory, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw new ImportError("Could not list an import directory.");
    }
  }
  async function add(filename, type, project, optional = false) {
    const resolved = resolvePath(filename);
    const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) return;
    let text;
    try {
      text = await io.readFile(resolved, "utf8");
    } catch (error) {
      if (optional && (error.code === "ENOENT" || error.code === "ENOTDIR")) return;
      throw new ImportError("Could not read an import file.");
    }
    seen.add(identity);
    files.push({ filename: resolved, type, project, text });
  }
  for (const [type, directory] of [
    ["skills", ".claude"], ["copilot", ".copilot"],
  ]) {
    if (!only.includes(type)) continue;
    const skills = path.join(root, directory, "skills");
    for (const entry of await directories(skills)) {
      if (entry.isDirectory()) {
        await add(path.join(skills, entry.name, "SKILL.md"), type, undefined, true);
      }
    }
  }
  if (only.includes("memory")) {
    const projects = path.join(root, ".claude", "projects");
    for (const project of await directories(projects)) {
      if (!project.isDirectory()) continue;
      const directory = path.join(projects, project.name, "memory");
      for (const entry of await directories(directory)) {
        if (entry.isFile() && /\.md$/iu.test(entry.name) &&
            entry.name.toUpperCase() !== "MEMORY.MD") {
          await add(path.join(directory, entry.name), "memory", project.name);
        }
      }
    }
  }
  if (only.includes("claude-md")) {
    await add(path.join(root, ".claude", "CLAUDE.md"), "claude-md", undefined, true);
  }
  for (const filename of include) {
    if (!/\.md$/iu.test(filename)) throw new ImportError("--include requires a Markdown (.md) file.");
    await add(filename, "include");
  }
  return files;
}

export function planImport(files, { home, state = {} }) {
  const root = resolvePath(home);
  return files.flatMap((file) => {
    const { attributes, body, header } = parseFrontmatter(file.text);
    const filename = resolvePath(file.filename);
    const relative = path.relative(root, filename).replaceAll("\\", "/");
    const outside = relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
    const basename = path.basename(file.filename.replace(/[\\/]/gu, path.sep));
    const name = textAttribute(attributes, "name", basename.replace(/\.md$/iu, ""));
    const description = textAttribute(attributes, "description", "");
    let notes;
    if (file.type === "skills" || file.type === "copilot") {
      notes = [{
        heading: "", raw: file.text, kind: "fact", title: name,
        summary: firstLine(description), text: body,
        tags: importTags(["skill", name, file.type === "copilot" ? "copilot" : "claude-code"], nameWords(name)),
      }];
    } else if (file.type === "memory") {
      const type = textAttribute(attributes.metadata ?? {}, "type", "unknown");
      const project = file.project?.split(/[\\/-]+/u).filter(Boolean).at(-1) ?? "unknown";
      notes = [{
        heading: "", raw: file.text,
        kind: type === "feedback" ? "preference" : type === "project" ? "decision" : "fact",
        title: name, summary: firstLine(description), text: body,
        tags: importTags(["memory", type, project], nameWords(name)),
      }];
    } else {
      notes = splitInstructions(body).map(({ heading, text }) => ({
        heading, raw: `${header}\n${heading}\n${text}`, kind: "preference",
        title: heading ? `${basename} / ${heading}` : basename,
        summary: "", text,
        tags: importTags(["instructions", heading || basename],
          heading.replace(/\([^)]*\)|\uFF08[^\uFF09]*\uFF09/gu, " ").match(/[\p{L}\p{N}]+/gu) ?? []),
      }));
    }
    const occurrences = new Map();
    return notes.map(({ heading, raw, ...note }) => {
      const occurrence = occurrences.get(heading) ?? 0;
      occurrences.set(heading, occurrence + 1);
      const key = JSON.stringify([relative, heading, occurrence]);
      const hash = digest(JSON.stringify({ raw, note }));
      const secret = findSecret([raw, note.title, note.summary, ...note.tags].join("\n"));
      const characters = Array.from(note.text);
      const truncated = characters.length > TEXT_LIMIT;
      const text = truncated
        ? characters.slice(0, TEXT_LIMIT - TRUNCATED.length).join("") + TRUNCATED
        : note.text;
      const change = state[key] === hash ? "unchanged" : Object.hasOwn(state, key) ? "changed" : "new";
      return {
        key, hash, secret: secret?.kind, truncated, change,
        status: secret ? "secret-skip" : change === "unchanged" ? change : truncated ? "truncated" : change,
        from: outside ? filename.replaceAll("\\", "/") : `~/${relative}`, chars: Array.from(text).length,
        memory: { ...note, text },
      };
    });
  });
}

export function parseImportState(text) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new ImportError("Import state is not valid JSON; no files were sent.");
  }
  if (
    state?.version !== 1 || !state.entries || typeof state.entries !== "object" ||
    Array.isArray(state.entries) ||
    Object.values(state.entries).some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
  ) {
    throw new ImportError("Import state has an unsupported format; no files were sent.");
  }
  return state.entries;
}

function display(value) {
  if (findSecret(value)) return "[redacted]";
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replaceAll("|", "\\|");
}

export function formatImportList(entries) {
  const rows = [
    ["status", "kind", "title", "from", "chars"],
    ...entries.map((entry) => [
      entry.secret ? `secret-skip (${entry.secret})` : entry.status,
      entry.memory.kind, display(entry.memory.title), display(entry.from), String(entry.chars),
    ]),
  ];
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => Array.from(row[index]).length)));
  return rows.map((row) => row.map((cell, index) =>
    cell + " ".repeat(widths[index] - Array.from(cell).length)).join(" | ").trimEnd()).join("\n");
}

export function importEndpoint(server, token, source) {
  let base;
  try {
    base = new URL(server);
  } catch {
    throw new ImportError("--server or JINAI_MEMORY_URL must be an HTTP(S) base URL.");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash) {
    throw new ImportError("The server URL must use HTTP(S), without credentials, query, or fragment.");
  }
  if (typeof token !== "string" || !token.trim()) {
    throw new ImportError("JINAI_MEMORY_TOKEN is required for --yes; tokens are never accepted as arguments.");
  }
  if (!/^[a-z0-9-]{1,20}$/u.test(source)) {
    throw new ImportError("--source must contain 1-20 lowercase letters, digits, or hyphens.");
  }
  base.pathname = `${base.pathname.replace(/\/$/u, "")}/mcp/${encodeURIComponent(token)}-${source}`;
  return base;
}

async function remember(endpoint, memory, id, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "remember", arguments: memory },
      }),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ImportError("Network request failed (connection, timeout, or redirect).");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImportError(`MCP request failed (HTTP ${response.status}).`);
  }
  let reply;
  try {
    reply = await response.json();
  } catch {
    throw new ImportError("MCP returned invalid JSON.");
  }
  if (reply?.jsonrpc !== "2.0" || reply.id !== id || reply.error) {
    throw new ImportError("MCP returned an invalid or failed JSON-RPC response.");
  }
  if (reply.result?.isError) throw new ImportError("MCP remember was rejected.");
  let saved;
  try {
    saved = JSON.parse(reply.result?.content?.find((item) => item.type === "text")?.text);
  } catch {
    throw new ImportError("MCP returned an invalid remember result.");
  }
  if (typeof saved?.id !== "string" || !saved.id.trim()) {
    throw new ImportError("MCP returned no memory id.");
  }
}

export async function sendImports(entries, {
  endpoint, state, saveState, fetchImpl = fetch, onFailure = () => {},
}) {
  const result = { success: 0, failed: 0, skipped: 0 };
  for (const [index, entry] of entries.entries()) {
    // Recheck the payload at the send boundary, even when the caller supplied a plan.
    if (entry.secret || entry.change === "unchanged" ||
        findSecret([entry.memory.title, entry.memory.text, entry.memory.summary, ...entry.memory.tags].join("\n"))) {
      result.skipped += 1;
      continue;
    }
    try {
      await remember(endpoint, entry.memory, index + 1, fetchImpl);
    } catch (error) {
      result.failed += 1;
      onFailure(index + 1, error instanceof ImportError ? error.message : "MCP request failed.");
      continue;
    }
    const next = { ...state, [entry.key]: entry.hash };
    try {
      await saveState(next);
    } catch {
      throw new ImportError("A memory was saved, but state could not be written. Import stopped; retrying may duplicate that memory.");
    }
    Object.assign(state, next);
    result.success += 1;
  }
  return result;
}
