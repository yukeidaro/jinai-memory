import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cleanUserText, createTranscriptExtractor, extractTranscript } from "../src/transcript-extract.js";
import { findSecret } from "../src/secret-guard.js";

const fixture = new URL("./fixtures/transcripts/C--Fictional-orbit/z-first.jsonl", import.meta.url);
const user = (text, extra = {}) => ({
  type: "user", sessionId: "fictional-session", timestamp: "2026-10-18T00:00:00Z",
  cwd: "/fictional/project", gitBranch: "main", message: { content: text }, ...extra,
});
const tool = (name, input) => ({
  type: "assistant", message: { content: [{ type: "tool_use", name, input }] },
});

test("transcripts extract only bounded human requests and approved metadata from fictional records", async () => {
  const records = (await readFile(fixture, "utf8")).trim().split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const result = extractTranscript(records);
  assert.equal(result.sessionId, "orbit-one");
  assert.equal(result.source, "claude-code");
  assert.equal(result.title, "Build the orbit map");
  assert.equal(result.occurredAt, "2026-10-15T09:00:00.000Z");
  assert.equal(result.project, "orbit");
  assert.equal(result.branch, "feature/map");
  assert.deepEqual(result.requests, [
    "Build a small orbit map.", "Keep the map compact and inspect [path]",
  ]);
  assert.deepEqual(result.files, ["src/map.js", "notes.md"]);
  assert.deepEqual(result.skills, ["map-review", "explore"]);
  assert.deepEqual(result.prs, ["https://github.com/fictional-lab/orbit/pull/12"]);
  assert.deepEqual(result.scale, { userMessages: 4, toolCalls: 6, durationMinutes: 10 });
  assert.equal(result.dropped, 1);
  assert.equal(result.memory.kind, "event");
  assert.equal(result.memory.summary, "orbit / feature/map: Build the orbit map");
  assert.deepEqual(result.memory.tags, ["orbit", "map.js", "notes.md", "map-review", "explore"]);
  for (const heading of ["頼んだこと", "触ったファイル", "使ったスキル", "PR", "規模"]) {
    assert.ok(result.memory.text.includes(`## ${heading}\n- `));
  }
  const serialized = JSON.stringify(result);
  for (const omitted of [
    "Fictional", "Elsewhere", "password", "fictional-value", "FICTIONAL_",
    "Injected private", "Automatic command", "fourth request", "Unknown record",
  ]) assert.ok(!serialized.includes(omitted), omitted);
  assert.equal(findSecret(JSON.stringify(result.memory)), null);
});

test("transcript title fallback and prompt caps count Unicode characters, not UTF-16 units", () => {
  const text = "\u{1F680}".repeat(250);
  const result = extractTranscript([user(text), user("second"), user("third"), user("fourth")]);
  assert.equal(Array.from(result.title).length, 60);
  assert.equal(Array.from(result.requests[0]).length, 200);
  assert.deepEqual(result.requests.slice(1), ["second", "third"]);
  assert.equal(result.scale.userMessages, 4);
  assert.ok(!result.memory.text.includes("fourth"));
  assert.equal(extractTranscript([user("fallback"), { type: "custom-title", other: "unknown" }]).title, "fallback");
  const longTitle = "A descriptive fictional title. ".repeat(5).trim();
  assert.equal(extractTranscript([user("fallback"), {
    type: "custom-title", customTitle: longTitle,
  }]).memory.title, longTitle);
});

test("transcript injection cleanup excludes automatic blocks and tool results, not adjacent human text", () => {
  assert.equal(cleanUserText([
    "<system-reminder>automatic</system-reminder>", "Please keep this.",
    "<command-name>/test</command-name>", "<command-args>generated</command-args>",
    "<local-command-stdout>automatic</local-command-stdout>",
    "<ide_opened_file>automatic</ide_opened_file>",
  ].join("\n")), "Please keep this.");
  assert.equal(cleanUserText("Human text. <system-reminder>unclosed automatic"), "Human text.");
  assert.equal(cleanUserText("<system-reminder />Human text."), "Human text.");
  assert.equal(cleanUserText(
    "<system-reminder>outer <system-reminder>inner</system-reminder> outer tail</system-reminder>Human text.",
  ), "Human text.");
  assert.equal(extractTranscript([
    user([{ type: "tool_result", content: "not human" }]),
    user("<command-name>/clear</command-name>"),
    user("meta", { isMeta: true }),
    user("sidechain", { isSidechain: true }),
    user("[Request interrupted by user for tool use]"),
  ]), null);
  assert.deepEqual(extractTranscript([user([
    { type: "text", text: "Human text." }, { type: "thinking", thinking: "private" },
    { type: "image", source: { data: "private" } }, { type: "tool_result", content: "private" },
  ])]).requests, ["Human text."]);
});

test("transcript extraction drops secret-bearing items before truncation and never leaks metadata secrets", () => {
  const fake = `ghp_${"fictional".repeat(4)}`;
  const result = extractTranscript([
    user(`A seemingly safe title ${"x".repeat(250)} ${fake}`),
    user("A safe request."),
    tool("Write", { file_path: `/fictional/project/${fake}.js` }),
    tool("Write", { file_path: "/fictional/project/safe.js" }),
    tool("Skill", { skill: fake }),
    tool("Bash", { command: `https://github.com/${fake}/project/pull/12` }),
    { type: "custom-title", customTitle: `Title ${fake}` },
    { type: "system", gitBranch: fake },
  ]);
  assert.equal(result.title, "Claude Code session");
  assert.deepEqual(result.requests, ["A safe request."]);
  assert.deepEqual(result.files, ["safe.js"]);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.prs, []);
  assert.equal(result.dropped, 6);
  assert.ok(!JSON.stringify(result).includes(fake));
  assert.equal(findSecret(JSON.stringify(result.memory)), null);
  assert.equal(extractTranscript([user("safe", { sessionId: fake })]), null);
});

test("transcript paths support Windows, POSIX, relative inputs, outside files and prefix siblings", () => {
  for (const [cwd, filenames] of [
    ["C:\\Fictional\\project", [
      "c:/fictional/project/src/file.js", "src\\file.js", "C:\\Fictional\\project-other\\outside.js",
      "D:\\private\\other.md", "..\\outside\\relative.md", "C:\\Fictional\\project\\src\\FILE.js",
    ]],
    ["/fictional/project", [
      "/fictional/project/src/file.js", "src/file.js", "/fictional/project-other/outside.js",
      "/private/other.md", "../outside/relative.md",
    ]],
  ]) {
    const result = extractTranscript([
      user("Review the files.", { cwd }), ...filenames.map((file_path) => tool("Edit", { file_path })),
    ]);
    assert.deepEqual(result.files, ["src/file.js", "outside.js", "other.md", "relative.md"]);
    assert.ok(!JSON.stringify(result.memory).includes("Fictional"));
    assert.ok(!JSON.stringify(result.memory).includes("/fictional/"));
  }
  const a = extractTranscript([user("safe", { cwd: "C:\\Fictional\\project" })]);
  const b = extractTranscript([user("safe", { cwd: "c:/fictional/project" })]);
  assert.equal(a.projectKey, b.projectKey);
  assert.equal(a.projectKey, extractTranscript([user("safe", { cwd: "C:\\Fictional\\project\\" })]).projectKey);
  assert.notEqual(a.projectKey, extractTranscript([user("safe", { cwd: "D:\\Other\\project" })]).projectKey);
  const paths = extractTranscript([user('Inspect "/home/fictional/My Project/a.js" and C:\\Private\\b.js.')]);
  assert.ok(!paths.memory.text.includes("/home/"));
  assert.ok(!paths.memory.text.includes("Private"));
  assert.deepEqual(extractTranscript([
    user("safe"), tool("Write", { file_path: "C:\\outside\\mixed.md" }),
  ]).files, ["mixed.md"]);
  for (const [cwd, text] of [
    ["/home/fictional/My Project", "Open </home/fictional/My Project/file.js>."],
    ["/home/fictional/project", "See file:///home/fictional/project/file.js."],
    ["/home/fictional/project", "See https://example.test/view?path=/home/fictional/project/file.js."],
    ["C:\\Fictional\\project", "See https://example.test/view?path=C:\\Fictional\\project\\file.js."],
  ]) {
    const result = extractTranscript([user(text, { cwd })]);
    assert.ok(!JSON.stringify(result.memory).includes(cwd.replaceAll("\\", "\\\\")), text);
    assert.ok(!result.memory.text.includes(cwd), text);
  }
});

test("transcript extraction bounds file, skill, PR and tag lists and ignores read-only tools", () => {
  const records = [user("safe")];
  for (let index = 0; index < 30; index += 1) {
    records.push(tool("Write", { file_path: `/fictional/project/file-${index}.js` }));
    records.push(tool("Skill", { skill: `skill-${index}` }));
    records.push(tool("Bash", { nested: [{ url: `https://github.com/example/repo/pull/${index + 1}` }] }));
  }
  records.push(tool("Read", { file_path: "/fictional/project/read-only.js" }));
  records.push(tool("NotebookEdit", { notebook_path: "/fictional/project/extra.ipynb" }));
  const result = extractTranscript(records);
  assert.equal(result.files.length, 20);
  assert.equal(result.skills.length, 10);
  assert.equal(result.prs.length, 5);
  assert.equal(result.memory.tags.length, 9);
  assert.equal(result.scale.toolCalls, 92);
  assert.ok(!result.files.includes("read-only.js"));
  assert.ok(Array.from(result.memory.text).length < 20_000);
  assert.equal(extractTranscript([user("safe"), tool("NotebookEdit", {
    notebook_path: "/fictional/project/demo.ipynb",
  })]).files[0], "demo.ipynb");
});

test("transcript extraction is incremental, handles malformed shapes, and requires usable session identity and dates", () => {
  const extractor = createTranscriptExtractor({ sessionId: "fallback-id" });
  for (const record of [null, [], "ignored", {}, { type: "future" }, user("safe", { sessionId: undefined })]) {
    extractor.add(record);
  }
  assert.equal(extractor.finish().sessionId, "fallback-id");
  assert.deepEqual(extractor.finish(), extractor.finish());
  assert.equal(extractTranscript([user("safe", { timestamp: "invalid" })]), null);
  assert.equal(extractTranscript([user("safe", { timestamp: "2026-02-30T00:00:00Z" })]), null);
  assert.equal(extractTranscript([user("safe", { sessionId: "../invalid" })]), null);
  assert.equal(extractTranscript([user("safe"), user("other", { sessionId: "another" })]), null);
});
