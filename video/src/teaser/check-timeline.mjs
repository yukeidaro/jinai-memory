import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ACTS, CAPTIONS, CAPTION_TOP, COPY, DURATION, ENGINE_ROWS, FPS, GRAPH_LABELS, HOLD_FROM,
  IMPORT_ROWS, READABLES, REPOSITORY_CHARS_PER_FRAME, REPOSITORY_FROM, WINDOW_HEIGHT, WRITE_ROWS,
  actAt, cameraAt, frameState, graphLabelsAt, motionAt, repeatDuration, typedText, validateTimeline,
} from "./timeline.mjs";

const result = validateTimeline();
assert.deepEqual(result.errors, []);
assert.equal(DURATION, 1650);
assert.equal(DURATION / FPS, 55);
assert.deepEqual(ACTS.map(({ from, to }) => [from, to]), [
  [0, 360], [360, 720], [720, 1110], [1110, 1440], [1440, 1650],
]);
assert.deepEqual([0, 359, 360, 719, 720, 1109, 1110, 1439, 1440, 1649, 1650].map(actAt), [
  "import", "import", "chatgpt", "chatgpt", "claude", "claude", "falkordb", "falkordb", "closing", "closing", null,
]);
assert.deepEqual(result.pauses.filter(({ duration }) => duration >= 15), [
  { from: HOLD_FROM, to: DURATION, duration: 90 },
]);
assert.deepEqual([0, 1, 2, 3].map(repeatDuration), [15, 15, 8, 8]);
assert.equal(typedText(22, 22, COPY.command), "");
assert.equal(typedText(23, 22, COPY.command), "n");
assert.equal(typedText(60, 22, COPY.command), COPY.command);
assert.equal(typedText(170, 150, COPY.confirm), " --yes");
assert.equal(typedText(440, 372, COPY.prompt), COPY.prompt);
assert.equal(typedText(800, 740, COPY.question), COPY.question);
assert.equal(typedText(REPOSITORY_FROM + 1, REPOSITORY_FROM, COPY.repository, REPOSITORY_CHARS_PER_FRAME), "gi");
assert.equal(typedText(1540, REPOSITORY_FROM, COPY.repository, REPOSITORY_CHARS_PER_FRAME), COPY.repository);
assert.equal(COPY.question, "What should I have for dinner tomorrow?");
const answer = COPY.answerBefore + COPY.answerEmphasis + COPY.answerAfter;
assert.equal(answer, "You just had burgers yesterday \u2014 how about grilled salmon tomorrow?");
assert.doesNotMatch(answer, /\btonight\b/i);
assert.deepEqual(ENGINE_ROWS.map(({ text }) => text), [
  "Write: a vector index wires related notes (SIMILAR edges)",
  "Read: follow edges \u2014 no search every turn",
  "Entry map \u2264 400 tokens, even at 2,000 notes",
  "One isolated graph per user",
]);
assert.ok(ENGINE_ROWS.every((row, index) =>
  row.from >= 1140 && row.from + repeatDuration(index) <= 1250 &&
  (index === 0 || row.from > ENGINE_ROWS[index - 1].from)));
assert.equal(frameState(270).import, 1);
assert.ok(360 - 270 >= FPS, "Import counter must hold at 114 for at least one second");
assert.ok(WINDOW_HEIGHT < 760, "Remove unused lower window space");
assert.ok(CAPTION_TOP <= 846, "Raise even the former two-line captions by at least 20px");
for (const caption of CAPTIONS) {
  assert.equal(caption.lines.length, 1, `Caption must stay on one line: ${caption.id}`);
  assert.ok(caption.lines[0].length <= 65, `Caption is too long: ${caption.id}`);
}
for (let frame = 420; frame < 560; frame += 1) {
  assert.equal(CAPTIONS.find((item) => frame >= item.from && frame < item.to)?.lines[0],
    "ChatGPT decides what\u2019s worth remembering.");
}
for (let frame = 840; frame < 1000; frame += 1) {
  assert.equal(CAPTIONS.find((item) => frame >= item.from && frame < item.to)?.lines[0],
    "Claude opens the shared memory on its own.");
}

for (let frame = 0; frame < DURATION; frame += 1) {
  const { camera, ...state } = frameState(frame);
  assert.ok(Object.values(camera).every(Number.isFinite));
  assert.ok(Object.values(state).every(Number.isFinite));
  assert.notDeepEqual(cameraAt(frame), cameraAt(frame + 1));
  if (frame >= HOLD_FROM) assert.equal(motionAt(frame).moving, false);
  if (frame >= DURATION - 90) {
    assert.equal(frameState(frame).repository, COPY.repository.length, `Incomplete final URL at f${frame}`);
    assert.equal(
      typedText(frameState(frame).frame, REPOSITORY_FROM, COPY.repository, REPOSITORY_CHARS_PER_FRAME),
      COPY.repository, `Truncated final URL at f${frame}`,
    );
  }
  if (frame >= 270 && frame < 360) assert.equal(Math.round(frameState(frame).import * 114), 114);
  const labels = graphLabelsAt(frame);
  assert.ok(labels.length <= 6, `Too many graph labels at f${frame}`);
  if (frame >= 505) assert.ok(!labels.some(({ text }) => text === "memory"));
  for (const [index, label] of labels.entries()) {
    assert.ok(label.x - 8 >= 0 && label.x - 8 + label.width <= 600 &&
      label.y - 30 >= 0 && label.y + 12 <= 560, `Clipped graph label: ${label.text}`);
    for (const other of labels.slice(index + 1)) {
      assert.ok(
        label.x + label.width <= other.x || other.x + other.width <= label.x ||
        label.y + 12 <= other.y - 30 || other.y + 12 <= label.y - 30,
        `Overlapping graph label backplates at f${frame}: ${label.text}, ${other.text}`,
      );
    }
  }
}
assert.deepEqual(
  { ...frameState(HOLD_FROM), camera: null },
  { ...frameState(DURATION - 1), camera: null },
);

// Negative controls ensure the checker rejects the actual forbidden outcomes.
assert.ok(validateTimeline({ acts: [...ACTS.slice(0, -1), { id: "short", from: 1440, to: 1649 }] }).errors.length);
assert.ok(validateTimeline({ captions: [{ id: "too-fast", from: 100, to: 135 }] }).errors.length);
assert.ok(validateTimeline({
  motion: (frame) => frame >= 100 && frame < 115 ? { moving: false } : motionAt(frame),
}).errors.some((error) => error.includes("Still for 15 frames at 100")));

const officialImports = new Set(["AbsoluteFill", "Easing", "interpolate", "spring", "useCurrentFrame"]);
const sources = {};
for (const name of ["kit.jsx", "JinAIMemoryDemo.jsx", "timeline.mjs", "check-timeline.mjs"]) {
  const source = await readFile(new URL(name, import.meta.url), "utf8");
  sources[name] = source;
  assert.doesNotMatch(source, /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u, `Non-English source: ${name}`);
  assert.doesNotMatch(source, /Illustrated\s+demo/i, `Removed label reintroduced: ${name}`);
  if (name.endsWith(".mjs")) continue;
  assert.doesNotMatch(source, /\b(?:Audio|Video|Img|staticFile|fetch)\b|https?:\/\/|Math\.random/, `External asset, audio, or nondeterministic rendering: ${name}`);
  assert.doesNotMatch(source, /\b(?:Cursor|Copilot)\b/, `Unapproved client name: ${name}`);
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    const names = match[1].split(",").map((value) => value.trim()).filter(Boolean);
    if (match[2] === "remotion") {
      for (const imported of names) assert.ok(officialImports.has(imported), `Unreviewed Remotion API: ${imported}`);
    } else if (match[2].startsWith(".")) {
      const target = await readFile(new URL(match[2], import.meta.url), "utf8");
      const exported = new Set([...target.matchAll(/export\s+(?:const|function)\s+(\w+)/g)].map((value) => value[1]));
      for (const imported of names) assert.ok(exported.has(imported), `Missing export ${imported} in ${match[2]}`);
    }
  }
}
const visibleCopy = [
  ...Object.values(COPY), ...IMPORT_ROWS.flatMap(({ label, value }) => [label, value]),
  ...WRITE_ROWS.flatMap(({ label, value }) => [label, value]),
  ...ENGINE_ROWS.map(({ text }) => text), ...CAPTIONS.flatMap(({ lines }) => lines),
  ...GRAPH_LABELS.map(({ text }) => text),
].join("\n");
assert.doesNotMatch(visibleCopy, /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u);
assert.doesNotMatch(CAPTIONS.flatMap(({ lines }) => lines).join("\n"), /['"]| - /);
assert.match(sources["kit.jsx"], /charsPerFrame=\{REPOSITORY_CHARS_PER_FRAME\}/);
assert.match(sources["kit.jsx"], /typedText\(state\.frame, from, text, charsPerFrame\)/);
assert.match(sources["kit.jsx"], /gridTemplateColumns:[^\n]+28px/);
assert.match(sources["kit.jsx"], /opacity: 0\.4/);
assert.doesNotMatch(sources["kit.jsx"], /vanish|memory:<user>/);
assert.match(sources["kit.jsx"], /frame < 12 \|\| frame >= 1470/);
assert.match(sources["kit.jsx"], /frame < 214/);
assert.match(sources["kit.jsx"], /connected: Jin AI Memory/);
assert.match(sources["kit.jsx"], /const labels = graphLabelsAt\(frame\)/);
assert.ok(sources["kit.jsx"].indexOf("{labels.map") > sources["kit.jsx"].indexOf('key="engine-photon"'),
  "Label backplates must cover graph points, edges, and moving particles");
assert.match(sources["JinAIMemoryDemo.jsx"], /top: CAPTION_TOP, whiteSpace: "nowrap"/);
assert.match(sources["JinAIMemoryDemo.jsx"], /Math\.round\(state\.import \* 114\)/);
const root = await readFile(new URL("../Root.jsx", import.meta.url), "utf8");
assert.match(root, /id="Demo"/);
assert.match(root, /id="JinAIMemoryDemo"\s+component=\{JinAIMemoryDemo\}\s+durationInFrames=\{1650\}\s+fps=\{30\}\s+width=\{1920\}\s+height=\{1080\}/);
const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
assert.ok(readme.replace(/\s+/g, " ").includes(COPY.query));

console.log(`PASS total: ${DURATION} frames / ${FPS} fps = 55 seconds (1920x1080).`);
console.log("PASS motion: no still interval >= 15 frames before f1560; camera excluded from this check.");
console.log("PASS final hold: f1560-f1650, exactly 90 frames; only camera continues.");
console.log("PASS full repository URL throughout the final 90 frames; closing types two characters per frame.");
console.log("PASS exact tomorrow question/answer, all four FalkorDB cards settled by f1250, and 114 counter held f270-f360.");
console.log("PASS graph label limit, non-overlapping backplates, hidden dinner classification, early graph preview, and retained stars.");
console.log("PASS raised single-line captions, including complete f420-f560 and f840-f1000 coverage; compact windows and aligned numeric/check columns.");
console.log(`PASS readability: ${READABLES.length} captions/answers/chip states, all >= 36 frames.`);
for (const caption of CAPTIONS) {
  console.log(`  ${caption.id}: f${caption.from}-f${caption.to} (${caption.to - caption.from} frames)`);
}
console.log("PASS typing, 15/15/8/8 repetition, finite frame drivers, continuous camera, and negative controls.");
console.log("PASS registration, local import/export names, documented Remotion import whitelist, README-exact Cypher, English-only source/copy, removed demo label, no external assets/audio.");
console.log("NOTE source checks are not a JSX compilation or a Remotion/browser render.");
