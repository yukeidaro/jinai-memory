import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ImportError, discoverFiles, formatImportList, importEndpoint, planImport, sendImports,
} from "../src/importer.js";
import {
  loadState as loadImportState, parseOptions as parseLocalOptions, saveState as saveImportState,
} from "./import-local.mjs";
import {
  discoverTranscripts, formatTranscriptList, loadState as loadTranscriptState,
  parseOptions as parseTranscriptOptions, planTranscripts, readTranscript,
  saveState as saveTranscriptState, sendTranscripts,
} from "./import-transcripts.mjs";

const HELP = `Usage: node scripts\\import.mjs [options]

Default: dry run with counts only; no network requests or state writes.
  --yes                    Send new/changed, non-secret files and sessions
  --server <url>           Server base URL (or JINAI_MEMORY_URL)
  --home <directory>       Home for files, session defaults and both state files
  --root <directory>       Transcript tree (default: <home>\\.claude\\projects)
  --exclude-project <name> Repeatable transcript exclusion; scratch projects are always excluded
  --include <file.md>      Additional instruction sections; repeatable
  --since YYYY-MM-DD       Sessions starting on/after this UTC date
  --limit <N>              At most N eligible sessions, oldest first
  --verbose                Show metadata tables, never bodies or summaries
  --help                   Show this help

Only JINAI_MEMORY_TOKEN supplies the token; there is no --token option.
State stays in <home>\\.jinai-memory\\import-state.json and transcript-state.json.`;

export function parseOptions(args, home = os.homedir()) {
  let values;
  try {
    ({ values } = parseArgs({
      args, strict: true, allowPositionals: false,
      options: {
        yes: { type: "boolean" }, server: { type: "string" }, home: { type: "string" },
        root: { type: "string" }, "exclude-project": { type: "string", multiple: true },
        include: { type: "string", multiple: true }, since: { type: "string" },
        limit: { type: "string" }, verbose: { type: "boolean" }, help: { type: "boolean" },
      },
    }));
  } catch {
    throw new ImportError("Invalid arguments. Use --help. Tokens must only be set in JINAI_MEMORY_TOKEN.");
  }
  if (values.help) return { help: true };
  const localArgs = [];
  const transcriptArgs = [];
  for (const name of ["home", "include", "root", "exclude-project", "since", "limit"]) {
    const target = ["home", "include"].includes(name) ? localArgs : transcriptArgs;
    for (const value of [].concat(values[name] ?? [])) target.push(`--${name}`, value);
  }
  const local = parseLocalOptions(localArgs, home);
  return {
    ...values, local, transcripts: parseTranscriptOptions(transcriptArgs, local.home),
  };
}

function category(entry) {
  return entry.type === "skills" || entry.type === "copilot" ? "skills"
    : entry.type === "memory" ? "memory files" : "CLAUDE.md sections";
}

function formatSummary(rows) {
  const width = Math.max(...rows.map(({ label }) => label.length)) + 3;
  const digits = Math.max(...rows.map(({ count }) => String(count).length));
  return rows.map(({ label, count, failed }) =>
    `${label.padEnd(width)}${String(count).padStart(digits)} ${failed ? `✗ (${failed} failed)` : "✓"}`
  ).join("\n");
}

export async function main(args = process.argv.slice(2), {
  env = process.env, home = os.homedir(), fetchImpl = fetch, log = console.log,
} = {}) {
  const options = parseOptions(args, home);
  if (options.help) {
    log(HELP);
    return { success: 0, failed: 0, skipped: 0 };
  }
  const endpoint = options.yes
    ? importEndpoint(options.server ?? env.JINAI_MEMORY_URL, env.JINAI_MEMORY_TOKEN, "claude-code")
    : undefined;
  const localState = await loadImportState(options.local.state);
  const transcriptState = await loadTranscriptState(options.transcripts.state);
  const files = await discoverFiles({ ...options.local, io: { readFile, readdir } });
  const local = planImport(files, { home: options.local.home, state: localState });
  const extracted = [];
  for (const filename of await discoverTranscripts(options.transcripts.root, options.transcripts.exclude)) {
    extracted.push(await readTranscript(filename));
  }
  const sessions = planTranscripts(extracted, options.transcripts, transcriptState);
  if (options.verbose) {
    log(formatImportList(local));
    log(formatTranscriptList(sessions));
  }
  const rows = ["skills", "memory files", "CLAUDE.md sections", "Claude Code sessions", "secrets skipped"]
    .map((label) => ({ label, count: 0, failed: 0 }));
  for (const entry of local) {
    rows.find(({ label }) => label === (entry.secret ? "secrets skipped" : category(entry))).count += 1;
  }
  rows[3].count = sessions.filter((entry) => entry.transcript && entry.status !== "skipped").length;
  rows[4].count += sessions.reduce((sum, entry) => sum + (entry.transcript?.dropped ?? 0), 0);
  const skippedSessions = sessions.filter((entry) => entry.status === "skipped").length;
  if (skippedSessions) log(`Skipped sessions: ${skippedSessions}. Use --verbose to review metadata.`);
  let result = { success: 0, failed: 0, skipped: local.length + sessions.length };
  if (options.yes) {
    const imported = await sendImports(local, {
      endpoint, state: localState, fetchImpl,
      saveState: (next) => saveImportState(options.local.state, next),
      onFailure: (index, reason) => {
        rows.find(({ label }) => label === category(local[index - 1])).failed += 1;
        log(`File entry ${index} failed: ${reason}`);
      },
    });
    const transcribed = await sendTranscripts(sessions, {
      endpoint, state: transcriptState, fetchImpl, log,
      externalIds: options.transcripts.externalIds,
      persist: (next) => saveTranscriptState(options.transcripts.state, next),
    });
    rows[3].failed = transcribed.failed;
    result = {
      success: imported.success + transcribed.success,
      failed: imported.failed + transcribed.failed,
      skipped: imported.skipped + transcribed.skipped,
    };
    log(`Import: success=${result.success}, failed=${result.failed}, skipped=${result.skipped}.`);
  } else {
    log("Dry run: nothing sent. Review with --verbose; to send, rerun with --yes.");
  }
  log(formatSummary(rows));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => {
    if (result.failed) process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof ImportError
      ? error.message : "Import failed while reading local files, transcripts or state. No error contents are displayed.");
    process.exitCode = 1;
  });
}
