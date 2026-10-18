import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ACTS, CAPTIONS, COPY, DURATION, FPS, HOLD_FROM, READABLES,
  actAt, cameraAt, frameState, motionAt, repeatDuration, typedText, validateTimeline,
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
assert.equal(typedText(1540, 1480, COPY.repository), COPY.repository);

for (let frame = 0; frame < DURATION; frame += 1) {
  const { camera, ...state } = frameState(frame);
  assert.ok(Object.values(camera).every(Number.isFinite));
  assert.ok(Object.values(state).every(Number.isFinite));
  assert.notDeepEqual(cameraAt(frame), cameraAt(frame + 1));
  if (frame >= HOLD_FROM) assert.equal(motionAt(frame).moving, false);
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
for (const name of ["kit.jsx", "JinAIMemoryDemo.jsx"]) {
  const source = await readFile(new URL(name, import.meta.url), "utf8");
  assert.doesNotMatch(source, /[\u3040-\u30ff\u3400-\u9fff]/u, `Non-English source: ${name}`);
  assert.doesNotMatch(source, /\b(?:Audio|Video|Img|staticFile|fetch)\b|https?:\/\/|Math\.random/, `External asset, audio, or nondeterministic rendering: ${name}`);
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
const root = await readFile(new URL("../Root.jsx", import.meta.url), "utf8");
assert.match(root, /id="Demo"/);
assert.match(root, /id="JinAIMemoryDemo"\s+component=\{JinAIMemoryDemo\}\s+durationInFrames=\{1650\}\s+fps=\{30\}\s+width=\{1920\}\s+height=\{1080\}/);
const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
assert.ok(readme.replace(/\s+/g, " ").includes(COPY.query));

console.log(`PASS total: ${DURATION} frames / ${FPS} fps = 55 seconds (1920x1080).`);
console.log("PASS motion: no still interval >= 15 frames before f1560; camera excluded from this check.");
console.log("PASS final hold: f1560-f1650, exactly 90 frames; only camera continues.");
console.log(`PASS readability: ${READABLES.length} captions/answers/chip states, all >= 36 frames.`);
for (const caption of CAPTIONS) {
  console.log(`  ${caption.id}: f${caption.from}-f${caption.to} (${caption.to - caption.from} frames)`);
}
console.log("PASS typing, 15/15/8/8 repetition, finite frame drivers, continuous camera, and negative controls.");
console.log("PASS registration, local import/export names, documented Remotion import whitelist, README-exact Cypher, English-only source, no external assets/audio.");
console.log("NOTE source checks are not a JSX compilation or a Remotion/browser render.");
