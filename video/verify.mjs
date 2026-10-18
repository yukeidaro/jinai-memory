import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createEmbedder } from "../src/embedder.js";
import { createEventHub } from "../src/events.js";
import { createMemory } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { captureConfig, createDemoClient, dinnerMemories, seedMemories } from "./capture/scenario.mjs";
import { FRAME_INTERVAL, GROUP_SETTLE_MS, JPEG_QUALITY, recordVerifiedBody, sceneState, startFrameCapture } from "./capture/capture.mjs";
import { loadClips, validateOutput } from "./render.mjs";
import {
  buildTimeline, CYPHER, DURATION, FPS, FRAME_INDEXES, frameAtTime,
  HEIGHT, isVerifiedSceneState, MAX_SCENE_BYTES, SCENES, VERIFIED_BODY_SECONDS, validateFrameIndex, WIDTH,
} from "./src/timeline.mjs";

const videoDir = fileURLToPath(new URL("./", import.meta.url));

async function verifyScenario() {
  const now = new Date("2026-10-18T03:00:00.000Z");
  const store = createMemoryStore();
  const hub = createEventHub();
  const touches = [];
  let embeddingCalls = 0;
  const fake = createEmbedder({ provider: "fake", dim: 128 });
  const memory = createMemory({
    store,
    embedder: {
      dim: fake.dim,
      embed(texts) {
        embeddingCalls += 1;
        return fake.embed(texts);
      },
    },
    now: () => now,
    onTouch(event) { touches.push(event); hub.publish(event); },
  });
  const token = randomUUID();
  const server = createServer({ memory, store, hub, token, user: "video-verification" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const config = captureConfig({
      JINAI_URL: `http://127.0.0.1:${server.address().port}`,
      JINAI_TOKEN: token,
    });
    const client = createDemoClient(config);
    assert.equal((await client.snapshot()).nodes.length, 0);
    const notes = seedMemories();
    assert.equal(notes.length, 8);
    assert.deepEqual(
      Object.fromEntries(["chatgpt", "claude", "cursor", "copilot"].map(
        (source) => [source, notes.filter((note) => note.source === source).length],
      )),
      { chatgpt: 2, claude: 2, cursor: 2, copilot: 2 },
    );
    for (const { source, arguments: args } of notes) await client.call(source, "remember", args);
    const [preference, event] = dinnerMemories(now);
    assert.equal(event.occurredAt, "2026-10-17T03:00:00.000Z");
    await client.call("chatgpt", "remember", preference);
    await client.call("chatgpt", "remember", event);
    const beforeRead = embeddingCalls;
    assert.match(await client.call("claude", "orient"), /ハンバーグ/u);
    const openedPreference = await client.call("claude", "open", { title: preference.title });
    const openedEvent = await client.call("claude", "open", { title: event.title });
    assert.equal(openedPreference.note.source, "chatgpt");
    assert.equal(openedEvent.note.source, "chatgpt");
    assert.equal(openedEvent.note.kind, "event");
    assert.equal(openedEvent.note.days_ago, 1);
    assert.equal(embeddingCalls, beforeRead);
    assert.equal(embeddingCalls, 10);
    assert.ok(touches.some((touch) =>
      touch.op === "open" && touch.source === "claude" &&
      touch.nodeIds.includes(openedEvent.note.id)));
    const snapshot = await client.snapshot();
    assert.equal(snapshot.nodes.filter((node) => node.type === "memory").length, 10);
    assert.equal(snapshot.nodes.filter((node) => node.source === "chatgpt").length, 4);
    assert.ok(snapshot.links.some((link) => link.type === "RELATES_TO"));
    assert.ok(snapshot.links.some((link) => link.type === "SIMILAR"));
    assert.ok(snapshot.links.some((link) => link.type === "MENTIONED_BY"));
    await assert.rejects(client.call("claude", "open", { title: "missing fictional note" }), /MCP operation was rejected/);
    console.log("Scenario verified against the real local HTTP/MCP server: 8 seed + 2 dinner notes, four authors, yesterday, Claude opens, access events, zero read embeddings.");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await store.close();
  }
}

function frameIndex(id, durationSeconds = 12) {
  return {
    version: 1, scene: id, width: WIDTH, height: HEIGHT, capture: "cdp", quality: JPEG_QUALITY,
    durationSeconds,
    frames: [
      { file: "000001.jpg", time: 0 },
      { file: "000002.jpg", time: 0.5 },
      { file: "000003.jpg", time: 1.7 },
    ],
  };
}

// Header fixtures exercise size validation, not image decoding or actual browser capture.
function jpegHeader(width = WIDTH, height = HEIGHT) {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0,
    3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9,
  ]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function verifiedState(id) {
  return {
    splitPressed: id === "group" ? "true" : "false",
    splitLabel: id === "group" ? "Restore force layout" : "Group by AI",
    detailsVisible: id === "read",
    detailTitle: id === "read" ? dinnerMemories()[1].title : "",
    detailSource: id === "read" ? "ChatGPT" : "",
    detailKind: id === "read" ? "event" : "",
    browserHidden: true,
  };
}

function verifiedBody(id) {
  return {
    startSeconds: 1.7, durationSeconds: VERIFIED_BODY_SECONDS,
    state: verifiedState(id), endState: verifiedState(id),
  };
}

async function verifySceneBodies() {
  assert.equal(GROUP_SETTLE_MS, 12_000);
  assert.equal(VERIFIED_BODY_SECONDS, 6);
  const bounds = { left: 1488, top: 96, right: 1896, bottom: 1012, width: 408, height: 916 };
  const style = { display: "block", visibility: "visible" };
  const details = { hidden: false, getBoundingClientRect: () => bounds };
  const elements = {
    "#details": details,
    "#split-toggle": { getAttribute: () => "false", textContent: "Group by AI" },
    "#detail-title": { textContent: dinnerMemories()[1].title },
    "#detail-source": { textContent: "ChatGPT" },
    "#detail-kind": { textContent: "event" },
    "#browser": { hidden: true },
  };
  const domPage = {
    async evaluate(callback) {
      return runInNewContext(`(${callback.toString()})()`, {
        document: { querySelector: (selector) => elements[selector] },
        getComputedStyle: () => style, innerWidth: WIDTH, innerHeight: HEIGHT,
      });
    },
  };
  assert.ok(isVerifiedSceneState("read", await sceneState(domPage)));
  for (const [target, key, invalid] of [
    [details, "hidden", true], [style, "display", "none"],
    [style, "visibility", "hidden"], [bounds, "width", 0], [bounds, "left", -1],
    [bounds, "right", WIDTH + 1], [bounds, "bottom", HEIGHT + 1],
  ]) {
    const previous = target[key];
    target[key] = invalid;
    assert.equal((await sceneState(domPage)).detailsVisible, false);
    target[key] = previous;
  }
  delete elements["#details"];
  assert.equal((await sceneState(domPage)).detailsVisible, false);
  elements["#details"] = details;
  for (const id of ["read", "group"]) {
    const calls = [];
    const state = verifiedState(id);
    const page = { async evaluate() { calls.push("state"); return state; } };
    const recorder = { async mark() { calls.push("frame"); return 1.7; } };
    const result = await recordVerifiedBody(page, recorder, id, async (milliseconds) => {
      calls.push(milliseconds);
    });
    assert.deepEqual(calls, ["state", "frame", 6_500, "state"]);
    assert.deepEqual(result.body, verifiedBody(id));
    assert.ok(isVerifiedSceneState(id, result.body.state));
    await assert.rejects(recordVerifiedBody({
      async evaluate() { return {}; },
    }, recorder, id), /required UI state is not visible/);
    let checks = 0;
    await assert.rejects(recordVerifiedBody({
      async evaluate() { return checks++ ? {} : state; },
    }, recorder, id, async () => {}), /did not survive the hold/);
    await assert.rejects(recordVerifiedBody(page, {
      async mark() { throw new Error("No frame after verification"); },
    }, id, async () => {}), /No frame after verification/);
  }
  const scenes = await readFile(path.join(videoDir, "src", "scenes.jsx"), "utf8");
  const demo = await readFile(path.join(videoDir, "src", "Demo.jsx"), "utf8");
  assert.match(scenes, /clip \|\| !requireVerifiedState \? <Captions items=\{captions\} graph \/> : null/);
  for (const id of ["read", "group"]) {
    const block = demo.slice(demo.indexOf(`    ${id}:`), demo.indexOf("    ),", demo.indexOf(`    ${id}:`)));
    assert.match(block, /requireVerifiedState/);
  }
  console.log("Scene-body guards verified with mocks: checked state, a new frame, 6.5-second hold, end-state check, failure propagation and read/group unavailable-caption wiring. No browser or JSX compiler was run.");
}

async function verifyFrameRecorder() {
  const directory = await mkdtemp(path.join(videoDir, ".verify-"));
  class Session extends EventEmitter {
    commands = [];
    detached = false;
    async send(method, args) {
      this.commands.push({ method, args });
      if (method === "Page.startScreencast") this.frame(1_000);
    }
    frame(timestamp) {
      this.emit("Page.screencastFrame", {
        data: jpegHeader().toString("base64"), metadata: { timestamp }, sessionId: this.commands.length,
      });
    }
    async detach() { this.detached = true; }
  }
  try {
    assert.equal(JPEG_QUALITY, 94);
    assert.equal(FRAME_INTERVAL, 0.125);
    assert.equal(MAX_SCENE_BYTES, 64 * 1024 * 1024);
    const session = new Session();
    let now = 100;
    const recorder = await startFrameCapture({
      context: () => ({ newCDPSession: async () => session }),
    }, path.join(directory, "cdp"), "write", { clock: () => now });
    session.frame(1_000.05);
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.frame(1_000.5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const marker = recorder.mark();
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.frame(1_001.7);
    assert.ok(Math.abs(await marker - 1.7) < 1e-9);
    await new Promise((resolve) => setTimeout(resolve, 10));
    now = 102;
    const index = await recorder.stop();
    assert.equal(index.capture, "cdp");
    assert.equal(index.durationSeconds, 2);
    assert.equal(index.frames.length, 3);
    assert.equal(index.bytes, jpegHeader().length * 3);
    assert.ok(Math.abs(index.frames[2].time - 1.7) < 1e-9);
    assert.deepEqual(session.commands.find(({ method }) => method === "Page.startScreencast").args, {
      format: "jpeg", quality: 94, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
    });
    assert.equal(session.commands.filter(({ method }) => method === "Page.screencastFrameAck").length, 4);
    assert.ok(session.commands.some(({ method }) => method === "Page.stopScreencast"));
    assert.ok(session.detached);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "cdp", "index.json"), "utf8")), index);

    const warnings = [];
    const screenshotOptions = [];
    const fallbackPage = {
      context: () => ({ newCDPSession: async () => { throw new Error("CDP unsupported"); } }),
      async screenshot(options) {
        screenshotOptions.push(options);
        return jpegHeader();
      },
    };
    now = 200;
    const fallback = await startFrameCapture(fallbackPage, path.join(directory, "fallback"), "read", {
      clock: () => now, warn: (message) => warnings.push(message),
    });
    const fallbackMarker = fallback.mark();
    now = 200.5;
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(await fallbackMarker, 0.5);
    now = 201;
    const fallbackIndex = await fallback.stop();
    assert.equal(fallbackIndex.capture, "screenshot");
    assert.equal(fallbackIndex.durationSeconds, 1);
    assert.deepEqual(fallbackIndex.frames.map(({ time }) => time), [0, 0.5]);
    assert.ok(screenshotOptions.every((options) =>
      options.type === "jpeg" && options.quality === 94 && options.scale === "css"));
    assert.match(warnings[0], /CDP screencast unavailable/);

    let screenshotCount = 0;
    let releaseShot;
    let notifyShot;
    const shotStarted = new Promise((resolve) => { notifyShot = resolve; });
    const pendingShot = new Promise((resolve) => { releaseShot = resolve; });
    now = 250;
    const inFlight = await startFrameCapture({
      ...fallbackPage,
      async screenshot() {
        if (++screenshotCount === 2) {
          notifyShot();
          await pendingShot;
        }
        return jpegHeader();
      },
    }, path.join(directory, "in-flight"), "read", {
      clock: () => now, warn: () => {},
    });
    now = 251;
    await shotStarted;
    const inFlightMarker = inFlight.mark();
    now = 252;
    releaseShot();
    assert.equal(await inFlightMarker, 2);
    now = 253;
    const inFlightIndex = await inFlight.stop();
    assert.deepEqual(inFlightIndex.frames.map(({ time }) => time), [0, 1, 2]);

    const silent = new Session();
    silent.frame = () => {};
    now = 300;
    const noFrames = await startFrameCapture({
      ...fallbackPage, context: () => ({ newCDPSession: async () => silent }),
    }, path.join(directory, "silent"), "ui-3d", {
      clock: () => now, firstFrameTimeout: 20, warn: (message) => warnings.push(message),
    });
    now = 303.5;
    assert.equal((await noFrames.stop()).durationSeconds, 3.5);
    assert.ok(silent.detached);
    assert.equal(warnings.length, 2);

    const broken = new Session();
    const originalSend = broken.send.bind(broken);
    broken.send = async (method, args) => {
      if (method === "Page.screencastFrameAck") throw new Error("ACK failed");
      return originalSend(method, args);
    };
    await assert.rejects(startFrameCapture({
      context: () => ({ newCDPSession: async () => broken }),
    }, path.join(directory, "broken"), "write"), /ACK failed/);
    assert.ok(broken.detached);

    const missingTimestamp = new Session();
    missingTimestamp.frame = function () {
      this.emit("Page.screencastFrame", {
        data: jpegHeader().toString("base64"), metadata: {}, sessionId: 1,
      });
    };
    now = 400;
    const withoutTimestamp = await startFrameCapture({
      ...fallbackPage, context: () => ({ newCDPSession: async () => missingTimestamp }),
    }, path.join(directory, "no-timestamp"), "write", {
      clock: () => now, warn: (message) => warnings.push(message),
    });
    now = 402;
    assert.equal((await withoutTimestamp.stop()).capture, "screenshot");
    assert.equal(warnings.length, 3);
    assert.ok(missingTimestamp.detached);

    const interrupted = new Session();
    const interruptedRecorder = await startFrameCapture({
      context: () => ({ newCDPSession: async () => interrupted }),
    }, path.join(directory, "interrupted"), "write");
    interrupted.frame(undefined);
    await assert.rejects(interruptedRecorder.stop(), /did not supply frame timestamps/);
    await assert.rejects(readFile(path.join(directory, "interrupted", "index.json")), { code: "ENOENT" });
    assert.ok(interrupted.detached);

    now = 500;
    const aborted = await startFrameCapture({
      context: () => ({ newCDPSession: async () => new Session() }),
    }, path.join(directory, "aborted"), "read", { clock: () => now });
    now = 502;
    await aborted.stop({ publish: false });
    await assert.rejects(aborted.mark(), /No new frame captured/);
    await assert.rejects(readFile(path.join(directory, "aborted", "index.json")), { code: "ENOENT" });
    console.log("Frame recorder verified with CDP mocks: official options, every-frame ACK, timestamp thinning, disk accounting, stop/detach, explicit screenshot fallback, no-frame timeout and ACK failure propagation. No browser was run.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyRenderingInputs() {
  let end = 0;
  for (const scene of SCENES) {
    assert.equal(scene.startFrame, end);
    assert.ok(scene.stillFrame > end && scene.stillFrame < end + scene.durationInFrames);
    assert.ok(Number.isInteger(scene.stillFrame));
    end += scene.durationInFrames;
  }
  assert.equal(end, DURATION);
  assert.equal(DURATION, 4_155);
  assert.deepEqual(
    SCENES.filter((scene) => !Object.hasOwn(FRAME_INDEXES, scene.id))
      .map(({ id, durationInFrames }) => [id, durationInFrames / FPS]),
    [["intro", 10], ["chatgpt", 25], ["claude", 30], ["falkordb", 30], ["outro", 10]],
  );
  assert.equal(SCENES.length, 9);
  assert.equal(SCENES[6].id, "ui-3d");
  const extended = buildTimeline({ group: { durationSeconds: 27.01 } });
  assert.equal(extended.scenes.find(({ id }) => id === "group").durationInFrames, 811);
  assert.equal(extended.durationInFrames, DURATION + 631);
  assert.throws(() => buildTimeline({ group: { durationSeconds: 55 } }), /Shorten capture waits/);
  assert.throws(() => buildTimeline({ read: { durationSeconds: NaN } }), /Invalid read/);
  for (const seconds of [2.99, 4.01]) {
    assert.throws(() => buildTimeline({ "ui-3d": { durationSeconds: seconds } }), /3-4 seconds/);
  }
  const sparse = frameIndex("read").frames;
  for (const [seconds, expected] of [[0, 0], [0.49, 0], [0.5, 1], [1.69, 1], [1.7, 2], [50, 2]]) {
    assert.equal(frameAtTime(sparse, seconds), sparse[expected]);
  }
  for (const change of [
    (value) => { value.width = 800; },
    (value) => { value.quality = 91; },
    (value) => { value.frames = []; },
    (value) => { value.frames[0].time = 0.1; },
    (value) => { value.frames[1].time = 0; },
    (value) => { value.frames[1].file = "../000002.jpg"; },
    (value) => { value.frames[2].time = value.durationSeconds; },
  ]) {
    const invalid = frameIndex("write");
    change(invalid);
    assert.throws(() => validateFrameIndex(invalid, "write"), /Invalid write/);
  }
  const readme = (await readFile(path.join(videoDir, "..", "README.md"), "utf8")).replace(/\r\n/g, "\n");
  for (const query of CYPHER) assert.ok(readme.includes(query.code), `README query differs: ${query.title}`);

  const warnings = [];
  const temporaryDir = await mkdtemp(path.join(videoDir, ".verify-"));
  try {
    const warn = (message) => warnings.push(message);
    assert.deepEqual(await loadClips(temporaryDir, warn), {});
    const manifest = {
      version: 2, storage: "memory", embeddings: "fake",
      clips: { write: { index: FRAME_INDEXES.write } },
    };
    const manifestPath = path.join(temporaryDir, "ui-timing.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await loadClips(temporaryDir, warn), {});
    async function fixture(id, seconds) {
      const index = frameIndex(id, seconds);
      if (id === "read" || id === "group") {
        index.frames = [0, 0.5, 1.7, 2.1, 4.7, 7.7, 8.2].map((time, position) => ({
          file: `${String(position + 1).padStart(6, "0")}.jpg`, time,
        }));
      }
      const indexPath = path.join(temporaryDir, FRAME_INDEXES[id]);
      await mkdir(path.dirname(indexPath), { recursive: true });
      await writeFile(indexPath, JSON.stringify(index));
      for (const frame of index.frames) {
        await writeFile(path.join(path.dirname(indexPath), frame.file), jpegHeader());
      }
    }
    await fixture("write", 14);
    const clips = await loadClips(temporaryDir, warn);
    assert.deepEqual(Object.keys(clips), ["write"]);
    assert.equal(clips.write.directory, "frames/ui-write");
    assert.equal(clips.write.durationSeconds, 14);
    for (const [id, seconds] of [["read", 13], ["group", 27], ["ui-3d", 3.5]]) {
      manifest.clips[id] = { index: FRAME_INDEXES[id] };
      if (id !== "ui-3d") manifest.clips[id].body = verifiedBody(id);
      await fixture(id, seconds);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    const allClips = await loadClips(temporaryDir, warn);
    assert.deepEqual(Object.keys(allClips), ["write", "read", "group", "ui-3d"]);
    for (const id of ["read", "group"]) {
      assert.equal(allClips[id].durationSeconds, 6);
      assert.deepEqual(allClips[id].frames.map(({ file }) => file), ["000003.jpg", "000004.jpg", "000005.jpg"]);
      assert.equal(allClips[id].frames[0].time, 0);
      assert.equal(frameAtTime(allClips[id].frames, 0).file, "000003.jpg");
      assert.equal(frameAtTime(allClips[id].frames, 5.99).file, "000005.jpg");
      assert.equal(buildTimeline(allClips).scenes.find((scene) => scene.id === id).durationInFrames, 180);
    }
    for (const id of ["read", "group"]) {
      const good = structuredClone(manifest.clips[id]);
      const changes = [
        (value) => { delete value.body; },
        (value) => { value.body.startSeconds = -1; },
        (value) => { value.body.startSeconds = "1.7"; },
        (value) => { value.body.startSeconds = 1.8; },
        (value) => { value.body.startSeconds = 8.2; },
        (value) => { value.body.durationSeconds = 5; },
        (value) => { value.body.state = {}; },
        (value) => { value.body.endState = {}; },
        ...(id === "group" ? [
          (value) => { value.body.state.splitPressed = "false"; },
          (value) => { value.body.state.splitPressed = true; },
          (value) => { value.body.state.splitLabel = "Group by AI"; },
        ] : [
          (value) => { value.body.state.detailsVisible = false; },
          (value) => { value.body.state.detailTitle = "A different dinner"; },
          (value) => { value.body.state.detailTitle = null; },
          (value) => { value.body.state.browserHidden = false; },
          (value) => { value.body.state.detailSource = "Claude"; },
          (value) => { value.body.state.detailKind = "preference"; },
        ]),
      ];
      for (const change of changes) {
        const invalid = structuredClone(good);
        change(invalid);
        manifest.clips[id] = invalid;
        await writeFile(manifestPath, JSON.stringify(manifest));
        const partial = await loadClips(temporaryDir, warn);
        assert.equal(partial[id], undefined);
        assert.ok(partial[id === "read" ? "group" : "read"]);
        assert.ok(partial.write);
        assert.ok(partial["ui-3d"]);
      }
      manifest.clips[id] = good;
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.ok(warnings.some((message) => message.includes("without claim subtitles")));
    const lastFrame = path.join(temporaryDir, "frames", "ui-read", "000003.jpg");
    await rm(lastFrame);
    assert.deepEqual(Object.keys(await loadClips(temporaryDir, warn)), ["write", "group", "ui-3d"]);
    await writeFile(lastFrame, jpegHeader(800, 600));
    await assert.rejects(loadClips(temporaryDir, warn), /1920x1080 JPEG/);
    await writeFile(lastFrame, "not a JPEG");
    await assert.rejects(loadClips(temporaryDir, warn), /not a complete JPEG/);
    await writeFile(lastFrame, jpegHeader());
    manifest.clips.write.index = "../unexpected/index.json";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadClips(temporaryDir, warn), /Invalid write capture timing/);
    await writeFile(manifestPath, "{");
    await assert.rejects(loadClips(temporaryDir, warn), SyntaxError);
    assert.ok(warnings.some((message) => message.includes("manifest")));
    assert.ok(warnings.some((message) => message.includes("missing")));
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
  const metadata = {
    format: { duration: String(DURATION / FPS) },
    streams: [{
      codec_type: "video", codec_name: "h264", width: WIDTH, height: HEIGHT,
      avg_frame_rate: "30/1",
    }],
  };
  assert.deepEqual(validateOutput(metadata), {
    seconds: 138.5, width: 1920, height: 1080, fps: 30, audioStreams: 0,
  });
  const longer = structuredClone(metadata);
  longer.format.duration = String(extended.durationInFrames / FPS);
  assert.equal(validateOutput(longer, extended.durationInFrames).seconds, extended.durationInFrames / FPS);
  assert.throws(() => validateOutput(longer), /Output must be/);
  for (const change of [
    (value) => { value.format.duration = "181"; },
    (value) => { value.streams[0].width = 1280; },
    (value) => { value.streams[0].avg_frame_rate = "25/1"; },
    (value) => { value.streams[0].codec_name = "vp8"; },
    (value) => { value.streams.push({ codec_type: "audio" }); },
  ]) {
    const invalid = structuredClone(metadata);
    change(invalid);
    assert.throws(() => validateOutput(invalid), /Output must be/);
  }
  for (const url of [
    "https://127.0.0.1", "http://example.com", "http://127.0.0.1/?token=not-a-real-token",
    "http://localhost/not-root",
  ]) {
    assert.throws(() => captureConfig({ JINAI_URL: url, JINAI_TOKEN: "disposable" }), /loopback/);
  }
  console.log("Rendering inputs verified: six-second read/group windows selected from exact verified frames, invalid/missing state and incomplete-window fallback without claims, 2:00-3:00 timeline, unchanged other scene lengths, 9 stills, timestamp selection, JPEG guards, README-exact Cypher, output guards and loopback-only capture.");
}

await verifyScenario();
await verifySceneBodies();
await verifyFrameRecorder();
await verifyRenderingInputs();
