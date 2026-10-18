import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ImportError, importEndpoint } from "../src/importer.js";
import { findSecret } from "../src/secret-guard.js";
import { createTranscriptExtractor, shortText, validSessionId } from "../src/transcript-extract.js";

const HELP = `Usage: node scripts\\import-transcripts.mjs [options]

Default: metadata-only dry run; no network requests or state writes.
  --root <directory>        Default: ~/.claude/projects
  --exclude-project <name>  Repeatable; scratch-workspaces and dated scratch cwd names are always excluded
  --since YYYY-MM-DD        Include sessions starting on/after this UTC date
  --limit <N>               At most N sessions, oldest first
  --session <sessionId>     Select one session
  --state <file>            Default: ~/.jinai-memory/transcript-state.json
  --yes                    Send new/changed sessions, one at a time
  --server <url>           Server base URL (or JINAI_MEMORY_URL)
  --no-external-id          Legacy server: no replacement or NEXT_STEP links
  --help                   Show this help

Only JINAI_MEMORY_TOKEN supplies the token; there is no --token option.`;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isoDate = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function parseOptions(args, home = os.homedir()) {
  let values;
  try {
    ({ values } = parseArgs({
      args, strict: true, allowPositionals: false,
      options: {
        root: { type: "string" }, "exclude-project": { type: "string", multiple: true },
        since: { type: "string" }, limit: { type: "string" }, session: { type: "string" },
        state: { type: "string" }, yes: { type: "boolean" }, server: { type: "string" },
        "no-external-id": { type: "boolean" }, help: { type: "boolean" },
      },
    }));
  } catch {
    throw new ImportError("Invalid arguments. Use --help. Tokens must only be set in JINAI_MEMORY_TOKEN.");
  }
  if (values.help) return { help: true };
  if (values.since !== undefined && (
    !/^\d{4}-\d{2}-\d{2}$/u.test(values.since) ||
    !isoDate(`${values.since}T00:00:00.000Z`) ||
    new Date(`${values.since}T00:00:00.000Z`).toISOString().slice(0, 10) !== values.since
  )) throw new ImportError("--since must be a valid YYYY-MM-DD date.");
  if (values.limit !== undefined && (!/^[1-9]\d*$/u.test(values.limit) ||
      !Number.isSafeInteger(Number(values.limit)))) {
    throw new ImportError("--limit must be a positive integer.");
  }
  if (values.session !== undefined && !validSessionId(values.session)) {
    throw new ImportError("--session must be a valid session ID.");
  }
  if (values["exclude-project"]?.some((value) => !value.trim())) {
    throw new ImportError("--exclude-project must not be empty.");
  }
  const resolve = (value) => path.resolve(value.replace(/[\\/]/gu, path.sep));
  return {
    ...values, root: resolve(values.root ?? path.join(home, ".claude", "projects")),
    state: resolve(values.state ?? path.join(home, ".jinai-memory", "transcript-state.json")),
    exclude: ["scratch-workspaces", ...(values["exclude-project"] ?? [])].map((value) => value.toLowerCase()),
    limit: values.limit === undefined ? undefined : Number(values.limit),
    externalIds: !values["no-external-id"],
  };
}

export async function discoverTranscripts(root, exclude = ["scratch-workspaces"]) {
  const files = [];
  async function visit(directory) {
    if (exclude.some((name) => path.basename(directory).toLowerCase().includes(name))) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && directory === root) return;
      throw new ImportError("Could not list a transcript directory; no files were sent.");
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && /\.jsonl$/iu.test(entry.name)) files.push(filename);
    }
  }
  await visit(root);
  return files;
}

export async function readTranscript(filename, { openStream = createReadStream } = {}) {
  const before = await stat(filename);
  const extractor = createTranscriptExtractor({ sessionId: path.parse(filename).name });
  const input = openStream(filename, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line.replace(/^\uFEFF/u, ""));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      extractor.add(record);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  const after = await stat(filename);
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    return { transcript: null, reason: "modified-during-read" };
  }
  return { transcript: extractor.finish(), mtimeMs: after.mtimeMs, size: after.size };
}

export function parseTranscriptState(text) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    throw new ImportError("Transcript state is not valid JSON; no files were sent.");
  }
  if (state?.version !== 1 || !object(state.entries) ||
      Object.entries(state.entries).some(([id, entry]) =>
        !validSessionId(id) || !object(entry) ||
        !Number.isFinite(entry.mtimeMs) || entry.mtimeMs < 0 ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        typeof entry.hash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.hash) ||
        typeof entry.projectKey !== "string" || !/^[a-f0-9]{64}$/u.test(entry.projectKey) ||
        !isoDate(entry.occurredAt) || typeof entry.externalIds !== "boolean" ||
        entry.follows !== undefined && !validSessionId(entry.follows))) {
    throw new ImportError("Transcript state has an unsupported format; no files were sent.");
  }
  return state.entries;
}

export async function loadState(filename) {
  try {
    return parseTranscriptState(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof ImportError) throw error;
    throw new ImportError("Could not read transcript state; no files were sent.");
  }
}

export async function saveState(filename, entries) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, {
      flag: "wx", mode: 0o600,
    });
    await rename(temporary, filename);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function payload(entry, follows, externalIds) {
  return {
    ...entry.transcript.memory,
    ...(externalIds ? {
      externalId: `cc-session:${entry.transcript.sessionId}`,
      ...(follows ? { follows: `cc-session:${follows}` } : {}),
    } : {}),
  };
}

function order(a, b) {
  return a.occurredAt.localeCompare(b.occurredAt) || a.sessionId.localeCompare(b.sessionId);
}

function predecessor(transcript, history) {
  return history.filter((previous) => previous.projectKey === transcript.projectKey &&
    previous.sessionId !== transcript.sessionId && order(previous, transcript) < 0).sort(order).at(-1)?.sessionId;
}

function historyOf(state) {
  return Object.entries(state).filter(([, value]) => value.externalIds)
    .map(([sessionId, value]) => ({ sessionId, projectKey: value.projectKey, occurredAt: value.occurredAt }));
}

function updateHistory(history, transcript) {
  const previous = history.findIndex((entry) => entry.sessionId === transcript.sessionId);
  if (previous !== -1) history.splice(previous, 1);
  history.push(transcript);
}

export function planTranscripts(entries, options, state = {}) {
  const selected = entries.filter(({ transcript }) => !transcript || (
    !options.exclude.some((name) => transcript.project.toLowerCase().includes(name)) &&
    !/^scratch-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/iu.test(transcript.project) &&
    (!options.session || transcript.sessionId === options.session) &&
    (!options.since || transcript.occurredAt >= `${options.since}T00:00:00.000Z`)
  )).filter(({ transcript }) => transcript || !options.session && !options.since)
    .sort((a, b) => a.transcript ? b.transcript ? order(a.transcript, b.transcript) : -1 : b.transcript ? 1 : 0);
  const history = historyOf(state);
  const seen = new Set();
  let count = 0;
  return selected.flatMap((entry) => {
    const transcript = entry.transcript;
    if (!transcript) return [{ ...entry, status: "skipped" }];
    if (seen.has(transcript.sessionId)) return [{ ...entry, transcript: null, status: "skipped", reason: "duplicate-session" }];
    seen.add(transcript.sessionId);
    if (options.limit !== undefined && count++ >= options.limit) return [];
    const follows = options.externalIds ? predecessor(transcript, history) : undefined;
    const memory = payload(entry, follows, options.externalIds);
    const hash = digest(JSON.stringify(memory));
    const previous = Object.hasOwn(state, transcript.sessionId) ? state[transcript.sessionId] : undefined;
    const status = previous?.hash === hash ? "unchanged" : previous ? "changed" : "new";
    updateHistory(history, transcript);
    return [{ ...entry, follows, memory, hash, status }];
  });
}

function display(value) {
  return (findSecret(value) ? "[redacted]" : value).replace(/[\p{Cc}\p{Cf}|]/gu, " ");
}

export function formatTranscriptList(entries) {
  const rows = [
    ["status", "date", "project", "title", "files", "dropped"],
    ...entries.map(({ status, transcript, reason }) => [
      status, transcript?.occurredAt.slice(0, 10) ?? "-",
      display(transcript?.project ?? "-"),
      display(shortText(transcript?.title ?? (reason ? `(${reason})` : "(no eligible user session)"), 60)),
      String(transcript?.files.length ?? 0), String(transcript?.dropped ?? 0),
    ]),
  ];
  const widths = rows[0].map((_, index) => rows.reduce((width, row) => Math.max(width, Array.from(row[index]).length), 0));
  return rows.map((row) => row.map((cell, index) =>
    cell + " ".repeat(widths[index] - Array.from(cell).length)).join(" | ").trimEnd()).join("\n");
}

async function remember(endpoint, memory, id, fetchImpl, externalIds) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "remember", arguments: memory } }),
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
  if (reply.result?.isError) throw new ImportError("MCP remember was rejected; check server externalId/follows support.");
  let saved;
  try {
    saved = JSON.parse(reply.result?.content?.find((item) => item.type === "text")?.text);
  } catch {
    throw new ImportError("MCP returned an invalid remember result.");
  }
  if (typeof saved?.id !== "string" || !saved.id.trim() ||
      externalIds && (typeof saved.replaced !== "boolean" || typeof saved.followsLinked !== "boolean")) {
    throw new ImportError("MCP returned an unsupported remember result.");
  }
  if (memory.follows && !saved.followsLinked) {
    throw new ImportError("Memory saved, but its NEXT_STEP link was not confirmed; state was not updated.");
  }
  return saved;
}

export async function sendTranscripts(entries, {
  endpoint, state, externalIds = true, fetchImpl = fetch, persist, log = console.log,
}) {
  const result = { success: 0, failed: 0, replaced: 0, skipped: 0 };
  const history = historyOf(state);
  for (const [index, entry] of entries.entries()) {
    if (!entry.transcript || entry.status === "skipped") {
      result.skipped += 1;
      continue;
    }
    const follows = externalIds ? predecessor(entry.transcript, history) : undefined;
    const memory = payload(entry, follows, externalIds);
    const hash = digest(JSON.stringify(memory));
    if (state[entry.transcript.sessionId]?.hash === hash) {
      result.skipped += 1;
      continue;
    }
    if (findSecret([memory.title, memory.summary, memory.text, ...memory.tags,
      memory.externalId ?? "", memory.follows ?? ""].join("\n"))) {
      result.skipped += 1;
      log(`Entry ${index + 1} skipped: secret guard rejected the outgoing metadata.`);
      continue;
    }
    let saved;
    try {
      saved = await remember(endpoint, memory, index + 1, fetchImpl, externalIds);
    } catch (error) {
      result.failed += 1;
      log(`Entry ${index + 1} failed: ${error instanceof ImportError ? error.message : "MCP request failed."}`);
      continue;
    }
    const transcript = entry.transcript;
    const next = {
      ...state, [transcript.sessionId]: {
        mtimeMs: entry.mtimeMs, size: entry.size, hash, projectKey: transcript.projectKey,
        occurredAt: transcript.occurredAt, externalIds, ...(follows ? { follows } : {}),
      },
    };
    try {
      await persist(next);
    } catch {
      throw new ImportError("A memory was saved, but transcript state could not be written. Import stopped.");
    }
    Object.assign(state, next);
    updateHistory(history, transcript);
    result.success += 1;
    if (saved.replaced) result.replaced += 1;
  }
  return result;
}

export async function main(args = process.argv.slice(2), {
  env = process.env, home = os.homedir(), fetchImpl = fetch, log = console.log,
} = {}) {
  const options = parseOptions(args, home);
  if (options.help) {
    log(HELP);
    return { success: 0, failed: 0, replaced: 0, skipped: 0 };
  }
  const endpoint = options.yes
    ? importEndpoint(options.server ?? env.JINAI_MEMORY_URL, env.JINAI_MEMORY_TOKEN, "claude-code") : undefined;
  const state = await loadState(options.state);
  const files = await discoverTranscripts(options.root, options.exclude);
  const extracted = [];
  for (const filename of files) extracted.push(await readTranscript(filename));
  const entries = planTranscripts(extracted, options, state);
  log(formatTranscriptList(entries));
  log(`Total: ${entries.length}; ${["new", "changed", "unchanged", "skipped"].map((status) =>
    `${status}=${entries.filter((entry) => entry.status === status).length}`).join(", ")}; dropped=${entries.reduce(
    (sum, entry) => sum + (entry.transcript?.dropped ?? 0), 0)}.`);
  if (!options.yes) {
    log("Dry run: nothing sent. To send, rerun with --yes.");
    return { success: 0, failed: 0, replaced: 0, skipped: entries.length };
  }
  if (!options.externalIds) log("Legacy mode: changed sessions append; replacement and NEXT_STEP links are disabled.");
  const result = await sendTranscripts(entries, {
    endpoint, state, externalIds: options.externalIds, fetchImpl, log,
    persist: (next) => saveState(options.state, next),
  });
  log(`Import: success=${result.success}, failed=${result.failed}, replaced=${result.replaced}, skipped=${result.skipped}.`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => {
    if (result.failed) process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof ImportError
      ? error.message : "Import failed while reading transcripts or state. No error contents are displayed.");
    process.exitCode = 1;
  });
}
