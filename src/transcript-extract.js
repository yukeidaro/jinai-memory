import { createHash } from "node:crypto";
import path from "node:path";
import { findSecret } from "./secret-guard.js";

const RECORD_TYPES = new Set([
  "user", "assistant", "system", "attachment", "custom-title", "last-prompt",
  "file-history-snapshot", "cost-state", "queue-operation",
]);
const INJECTED_TAGS = [
  "system-reminder", "command-name", "command-message", "command-args",
  "local-command-stdout", "local-command-stderr", "local-command-caveat",
  "task-notification", "ide_opened_file", "ide_selection",
  "user-prompt-submit-hook-output", "available-deferred-tools",
].join("|");
const INJECTION = new RegExp(`<\\/?(?:${INJECTED_TAGS})\\b[^>]*>`, "giu");
const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.=-]+\/[A-Za-z0-9_.=-]+\/pull\/\d+\b/giu;

export function shortText(value, limit) {
  let text = "";
  let count = 0;
  for (const character of value) {
    if (count++ === limit) break;
    text += character;
  }
  return text;
}

function oneLine(value) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
}

export function cleanUserText(value) {
  let text = "";
  let depth = 0;
  let cursor = 0;
  for (const match of value.matchAll(INJECTION)) {
    if (!depth) text += `${value.slice(cursor, match.index)} `;
    if (match[0].startsWith("</")) depth = Math.max(0, depth - 1);
    else if (!/\/\s*>$/u.test(match[0])) depth += 1;
    cursor = match.index + match[0].length;
  }
  if (!depth) text += value.slice(cursor);
  text = text.trim();
  if (/^(?:\[Request interrupted by user|This session is being continued from a previous conversation)/u.test(text)) {
    return "";
  }
  return oneLine(text);
}

function pathStyle(value) {
  return /^(?:[A-Za-z]:|\\\\)/u.test(value) || value.includes("\\") ? path.win32 : path.posix;
}

function basename(value) {
  return pathStyle(value).basename(value.replace(/[\\/]$/u, ""));
}

function withoutAbsolutePaths(value, cwd) {
  if (cwd && cwd.length > pathStyle(cwd).parse(cwd).root.length) {
    const root = cwd.replace(/[\\/]+$/u, "").split(/[\\/]/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[\\\\/]");
    value = value.replace(new RegExp(`${root}(?:[\\\\/][^\\s<>"'\`|]*)?`,
      pathStyle(cwd) === path.win32 ? "giu" : "gu"), "[path]");
  }
  // Preserve URLs, but never carry machine-specific absolute paths into a note.
  return value.replace(
    /https?:\/\/[^\s<>"'`]+|file:\/\/[^\s<>"'`]+|(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'`\r\n]*\1|[A-Za-z]:[\\/][^\s<>"'`|]*|\\\\[^\s<>"'`|]+|(^|[\s([=:<>])\/(?!\/)[^\s<>"'`|]+/giu,
    (match) => /^https?:\/\//iu.test(match)
      ? match.replace(/[A-Za-z]:[\\/][^\s<>"'`|]*/gu, "[path]")
      : `${/^\s/u.test(match) ? " " : ""}[path]`,
  );
}

function safeLine(value, limit = Number.MAX_SAFE_INTEGER, cwd) {
  return shortText(oneLine(withoutAbsolutePaths(value, cwd)), limit);
}

function relativeFile(filename, cwd) {
  const style = pathStyle(cwd || filename);
  const fileStyle = pathStyle(filename);
  if (style !== fileStyle && fileStyle.isAbsolute(filename)) return fileStyle.basename(filename);
  const normalized = filename.replace(/[\\/]/gu, style.sep);
  if (!cwd) return basename(normalized);
  const root = style.normalize(cwd.replace(/[\\/]/gu, style.sep));
  const target = style.resolve(root, normalized);
  const relative = style.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${style.sep}`) || style.isAbsolute(relative)) {
    return style.basename(target);
  }
  return relative.replaceAll("\\", "/");
}

function timestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) && Number.isFinite(day.getTime()) &&
    day.toISOString().slice(0, 10) === value.slice(0, 10) ? milliseconds : undefined;
}

function textBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

export function validSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value) && !findSecret(value);
}

export function createTranscriptExtractor({ sessionId: fallbackId } = {}) {
  let sessionId;
  let cwd = "";
  let branch = "";
  let customTitle = "";
  let firstTitle = "";
  let first;
  let last;
  let users = 0;
  let tools = 0;
  let dropped = 0;
  let skipped = false;
  const requests = [];
  const files = new Map();
  const skills = new Set();
  const prs = new Set();

  function safe(value) {
    if (findSecret(value)) {
      dropped += 1;
      return false;
    }
    return true;
  }

  function collectPrs(value) {
    for (const [url] of value.matchAll(PR_URL)) {
      if (!safe(url)) continue;
      if (prs.size < 5) prs.add(url);
    }
  }

  function inputPrs(value) {
    if (typeof value === "string") collectPrs(value);
    else if (Array.isArray(value)) {
      for (const item of value) inputPrs(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) inputPrs(item);
    }
  }

  function add(record) {
    if (!record || typeof record !== "object" || !RECORD_TYPES.has(record.type)) return;
    if (record.isSidechain) return;
    if (typeof record.sessionId === "string") {
      if (!validSessionId(record.sessionId) || sessionId && sessionId !== record.sessionId) skipped = true;
      else sessionId = record.sessionId;
    }
    const at = timestamp(record.timestamp);
    if (at !== undefined) {
      first = first === undefined ? at : Math.min(first, at);
      last = last === undefined ? at : Math.max(last, at);
    }
    if (!cwd && typeof record.cwd === "string" && record.cwd.trim()) cwd = record.cwd;
    if (typeof record.gitBranch === "string" && record.gitBranch.trim()) {
      branch = safe(record.gitBranch) ? safeLine(record.gitBranch, 100, cwd) : "";
    }
    if (record.type === "custom-title") {
      const value = record.customTitle ?? record.title;
      if (typeof value === "string" && value.trim()) {
        customTitle = safe(value) ? safeLine(value, undefined, cwd) : "";
      }
    }
    if (record.type !== "user" && record.type !== "assistant") return;
    const content = record.message?.content;
    if (record.type === "user" && !record.isMeta) {
      const text = cleanUserText(textBlocks(content).join("\n"));
      if (text) {
        users += 1;
        const allowed = safe(text);
        if (users === 1 && allowed) firstTitle = safeLine(text, 60, cwd);
        if (users <= 3 && allowed) requests.push(safeLine(text, 200, cwd));
        collectPrs(text);
      }
    }
    if (record.type !== "assistant") return;
    for (const text of textBlocks(content)) collectPrs(text);
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      tools += 1;
      const input = block.input;
      inputPrs(input);
      if (!input || typeof input !== "object") continue;
      const filename = input.file_path ?? (block.name === "NotebookEdit" ? input.notebook_path : undefined);
      if (["Edit", "Write", "NotebookEdit"].includes(block.name) &&
          typeof filename === "string" && filename.trim() && safe(filename)) {
        const relative = relativeFile(filename, cwd);
        const display = safeLine(relative, 240);
        const key = pathStyle(cwd || filename) === path.win32 ? display.toLowerCase() : display;
        if (display && safe(relative) && files.size < 20 && !files.has(key)) files.set(key, display);
      }
      const skill = block.name === "Skill" ? input.skill : block.name === "Agent" ? input.subagent_type : undefined;
      if (typeof skill === "string" && skill.trim() && safe(skill) && skills.size < 10) {
        const name = safeLine(skill, 100, cwd);
        if (name) skills.add(name);
      }
    }
  }

  function finish() {
    const id = sessionId ?? fallbackId;
    if (skipped || !validSessionId(id) || !users || first === undefined) return null;
    const projectName = basename(cwd) || "unknown";
    const secretProject = findSecret(projectName);
    const project = secretProject ? "unknown" : shortText(oneLine(projectName), 100) || "unknown";
    const projectPath = cwd ? pathStyle(cwd).normalize(cwd).replace(/[\\/]+$/u, "") : `unknown:${id}`;
    const projectKey = createHash("sha256")
      .update(pathStyle(cwd) === path.win32 ? projectPath.toLowerCase() : projectPath).digest("hex");
    const title = safeLine(customTitle || firstTitle || "Claude Code session", undefined, cwd);
    const safeBranch = safeLine(branch, 100, cwd);
    const safeSkills = [...skills].map((skill) => safeLine(skill, 100, cwd));
    const occurredAt = new Date(first).toISOString();
    const scale = { userMessages: users, toolCalls: tools, durationMinutes: Math.round((last - first) / 600) / 100 };
    const tags = [...new Set([
      project, ...[...files.values()].slice(0, 5).map(basename), ...safeSkills.slice(0, 3),
    ])].slice(0, 10);
    const safeRequests = requests.map((request) => safeLine(request, 200, cwd));
    const sections = [
      ["頼んだこと", safeRequests], ["触ったファイル", [...files.values()]],
      ["使ったスキル", safeSkills], ["PR", [...prs]],
      ["規模", [`user messages: ${users}; tool calls: ${tools}; minutes: ${scale.durationMinutes}`]],
    ];
    const text = sections.map(([heading, items]) =>
      `## ${heading}\n${items.map((item) => `- ${item}`).join("\n") || "- (none)"}`).join("\n\n");
    return {
      sessionId: id, source: "claude-code", project, projectKey, branch: safeBranch, title, occurredAt,
      requests: safeRequests, files: [...files.values()], skills: safeSkills, prs: [...prs], scale,
      dropped: dropped + (secretProject ? 1 : 0),
      memory: {
        kind: "event", title, occurredAt, text,
        summary: `${project} / ${safeBranch || "(no branch)"}: ${title}`, tags,
      },
    };
  }
  return { add, finish };
}

export function extractTranscript(records, options) {
  const extractor = createTranscriptExtractor(options);
  for (const record of records) extractor.add(record);
  return extractor.finish();
}
