import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { measureFinalRecordings, recordingSeconds } from "../../measure-final.mjs";
import { validateFinalOutput } from "../../render-final.mjs";
import {
  buildFinalTimeline, CAPTION_FROM, EMPTY_DURATIONS, FADE_FRAMES, FPS, RECORDINGS,
} from "./timeline.mjs";

function durations(seconds) {
  return { version: 1, clips: Object.fromEntries(RECORDINGS.map(({ file }, index) => [file, seconds[index]])) };
}

test("no recordings gives four 4-second pending cards and two fully visible stills", () => {
  const timeline = buildFinalTimeline(EMPTY_DURATIONS);
  assert.equal(timeline.durationInFrames, 31 * FPS);
  assert.deepEqual(timeline.scenes.map(({ startFrame }) => startFrame), [0, 150, 270, 390, 510, 630]);
  assert.deepEqual(timeline.scenes.slice(1, -1).map(({ pending }) => pending), [true, true, true, true]);
  assert.equal(CAPTION_FROM, 9);
  assert.equal(FADE_FRAMES, 12);
  assert.equal(timeline.stills.length, 2);
  for (const [index, scene] of [timeline.scenes[0], timeline.scenes.at(-1)].entries()) {
    const frame = timeline.stills[index].frame;
    assert.ok(frame >= scene.startFrame + FADE_FRAMES);
    assert.ok(frame < scene.startFrame + scene.durationInFrames - FADE_FRAMES);
  }
});

test("committed/generated manifest is valid", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../public/final/durations.json", import.meta.url), "utf8"));
  assert.ok(buildFinalTimeline(manifest).durationInFrames >= 450);
});

test("measurement writes a complete pending manifest without needing ffprobe when no recordings exist", async () => {
  const directory = await mkdtemp(fileURLToPath(new URL("../../.verify-final-", import.meta.url)));
  try {
    const manifest = await measureFinalRecordings(directory);
    assert.deepEqual(manifest, EMPTY_DURATIONS);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "durations.json"), "utf8")), manifest);
    assert.equal(buildFinalTimeline(manifest).durationInFrames, 930);
    await mkdir(path.join(directory, RECORDINGS[0].file));
    await assert.rejects(measureFinalRecordings(directory), /must be a recording file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recordings determine total length, keep sequence order, and move the closing still", () => {
  const timeline = buildFinalTimeline(durations([10, 15, 20, 10]));
  assert.equal(timeline.durationInFrames, 70 * FPS);
  assert.deepEqual(timeline.scenes.slice(1, -1).map(({ file }) => file), RECORDINGS.map(({ file }) => file));
  assert.equal(timeline.stills[1].frame, 62 * FPS);
  let end = 0;
  for (const scene of timeline.scenes) {
    assert.equal(scene.startFrame, end);
    end += scene.durationInFrames;
  }
  assert.equal(end, timeline.durationInFrames);
});

test("partial recordings, fractional frames and the exact 25-second cap", () => {
  const timeline = buildFinalTimeline(durations([1.01, null, 25, 25.01]));
  assert.deepEqual(timeline.scenes.slice(1, -1).map(({ durationInFrames }) => durationInFrames), [31, 120, 750, 750]);
  assert.equal(timeline.scenes[2].pending, true);
  assert.equal(buildFinalTimeline(durations([30, 60, 90, 120])).durationInFrames, 115 * FPS);
  assert.equal(buildFinalTimeline(durations([0.001, null, null, null])).scenes[1].durationInFrames, 1);
});

test("malformed manifests fail explicitly rather than hiding invalid recordings", () => {
  for (const invalid of [undefined, {}, { version: 2, clips: {} }, { version: 1, clips: [] }]) {
    assert.throws(() => buildFinalTimeline(invalid), /Invalid final/);
  }
  for (const invalid of [undefined, 0, -1, NaN, Infinity, "4", false]) {
    assert.throws(() => buildFinalTimeline(durations([invalid, null, null, null])), /Invalid duration/);
  }
});

test("ffprobe prefers video duration, handles unavailable stream duration, and rejects invalid media", () => {
  const metadata = { streams: [{ codec_type: "video", duration: "10.01" }], format: { duration: "12" } };
  assert.equal(recordingSeconds(metadata, "fixture.mp4"), 10.01);
  metadata.streams[0].duration = "N/A";
  assert.equal(recordingSeconds(metadata, "fixture.mp4"), 12);
  for (const invalid of [
    { streams: [{ codec_type: "audio" }], format: { duration: "12" } },
    { streams: [{ codec_type: "video" }], format: { duration: "N/A" } },
    { streams: [{ codec_type: "video", duration: "0" }] },
  ]) {
    assert.throws(() => recordingSeconds(invalid, "fixture.mp4"), /Cannot measure/);
  }
});

test("MP4 must match measured frame count, H.264, 1920x1080, 30fps and zero audio", () => {
  const frames = 31 * FPS;
  const metadata = {
    streams: [{
      codec_type: "video", codec_name: "h264", width: 1920, height: 1080,
      avg_frame_rate: "30/1", nb_read_frames: String(frames),
    }],
    format: { duration: "31" },
  };
  assert.equal(validateFinalOutput(metadata, frames).audioStreams, 0);
  for (const change of [
    (value) => { value.streams[0].nb_read_frames = "929"; },
    (value) => { value.streams[0].codec_name = "vp9"; },
    (value) => { value.streams[0].width = 1280; },
    (value) => { value.streams[0].height = 720; },
    (value) => { value.streams[0].avg_frame_rate = "30000/1001"; },
    (value) => { value.format.duration = "32"; },
    (value) => { value.streams.push({ codec_type: "audio" }); },
  ]) {
    const invalid = structuredClone(metadata);
    change(invalid);
    assert.throws(() => validateFinalOutput(invalid, frames), /Final output must be/);
  }
});
