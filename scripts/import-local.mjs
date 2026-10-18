import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  IMPORT_TYPES, ImportError, discoverFiles, formatImportList, importEndpoint,
  parseImportState, planImport, sendImports,
} from "../src/importer.js";

const HELP = `Usage: node scripts\\import-local.mjs [options]

Default: list metadata only; no network requests or state writes.
  --home <directory>     Home to scan (default: your home)
  --include <file.md>     Add a Markdown file; repeatable, independent of --only
  --only <types>         Comma-separated skills,memory,claude-md,copilot
  --state <file>         State file (default: <home>\\.jinai-memory\\import-state.json)
  --yes                  Send new/changed, non-secret entries
  --server <url>         Server base URL (or JINAI_MEMORY_URL)
  --source <name>        MCP source, default: claude-code
  --help                 Show this help

Only JINAI_MEMORY_TOKEN supplies the token; there is no --token option.`;

export function parseOptions(args, home) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        home: { type: "string" }, include: { type: "string", multiple: true },
        only: { type: "string" }, state: { type: "string" },
        yes: { type: "boolean" }, server: { type: "string" },
        source: { type: "string", default: "claude-code" }, help: { type: "boolean" },
      },
      strict: true, allowPositionals: false,
    }));
  } catch {
    throw new ImportError("Invalid arguments. Use --help. Tokens must only be set in JINAI_MEMORY_TOKEN.");
  }
  if (values.help) return { help: true };
  const only = values.only === undefined ? IMPORT_TYPES : values.only.split(",");
  if (!only.length || only.some((value) => !IMPORT_TYPES.includes(value))) {
    throw new ImportError("--only accepts skills,memory,claude-md,copilot.");
  }
  if (!/^[a-z0-9-]{1,20}$/u.test(values.source)) {
    throw new ImportError("--source must contain 1-20 lowercase letters, digits, or hyphens.");
  }
  const resolve = (value) => path.resolve(value.replace(/[\\/]/gu, path.sep));
  const root = resolve(values.home ?? home);
  return {
    ...values, home: root, only, include: (values.include ?? []).map(resolve),
    state: values.state === undefined
      ? path.join(root, ".jinai-memory", "import-state.json") : resolve(values.state),
  };
}

export async function loadState(filename) {
  let text;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new ImportError("Could not read the import state; no files were sent.");
  }
  return parseImportState(text);
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

export async function main(args = process.argv.slice(2), {
  env = process.env, home = os.homedir(), fetchImpl = fetch, log = console.log,
} = {}) {
  const options = parseOptions(args, home);
  if (options.help) {
    log(HELP);
    return { success: 0, failed: 0, skipped: 0 };
  }
  const endpoint = options.yes
    ? importEndpoint(options.server ?? env.JINAI_MEMORY_URL, env.JINAI_MEMORY_TOKEN, options.source)
    : undefined;
  const state = await loadState(options.state);
  const files = await discoverFiles({ ...options, io: { readFile, readdir } });
  const entries = planImport(files, { home: options.home, state });
  log(formatImportList(entries));
  const counts = ["new", "changed", "unchanged", "secret-skip", "truncated"]
    .map((status) => `${status}=${entries.filter((entry) => entry.status === status).length}`);
  log(`Total: ${entries.length}; ${counts.join(", ")}.`);
  if (!options.yes) {
    log("Dry run: nothing sent. To send, rerun with --yes.");
    return { success: 0, failed: 0, skipped: entries.length };
  }
  const result = await sendImports(entries, {
    endpoint, state, fetchImpl,
    saveState: (next) => saveState(options.state, next),
    onFailure: (index, reason) => log(`Entry ${index} failed: ${reason}`),
  });
  log(`Import: success=${result.success}, failed=${result.failed}, skipped=${result.skipped}.`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => {
    if (result.failed) process.exitCode = 1;
  }).catch((error) => {
    console.error(error instanceof ImportError
      ? error.message : "Import failed while reading local files or state. No error contents are displayed.");
    process.exitCode = 1;
  });
}
