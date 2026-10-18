import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder } from "../src/embedder.js";
import { createEventHub } from "../src/events.js";
import { createMemory } from "../src/memory.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store/memory-store.js";
import { captureConfig, createDemoClient, dinnerMemories, seedMemories } from "./capture/scenario.mjs";
import { loadClips, validateOutput } from "./render.mjs";
import { CLIP_FILES, CYPHER, DURATION, FPS, HEIGHT, SCENES, WIDTH } from "./src/timeline.mjs";

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

async function verifyRenderingInputs() {
  let end = 0;
  for (const scene of SCENES) {
    assert.equal(scene.start, end);
    assert.ok(scene.still > scene.start && scene.still < scene.start + scene.seconds);
    assert.ok(Number.isInteger(scene.still * FPS));
    end += scene.seconds;
  }
  assert.equal(end * FPS, DURATION);
  assert.equal(DURATION, 4500);
  assert.equal(SCENES.length, 8);
  const readme = (await readFile(path.join(videoDir, "..", "README.md"), "utf8")).replace(/\r\n/g, "\n");
  for (const query of CYPHER) assert.ok(readme.includes(query.code), `README query differs: ${query.title}`);

  const warnings = [];
  const temporaryDir = await mkdtemp(path.join(videoDir, ".verify-"));
  try {
    const warn = (message) => warnings.push(message);
    const validProbe = async () => ({
      format: { duration: "20.0" },
      streams: [{ codec_type: "video", width: WIDTH, height: HEIGHT }],
    });
    assert.deepEqual(await loadClips(temporaryDir, validProbe, warn), {});
    const manifest = {
      version: 1, storage: "memory", embeddings: "fake",
      clips: { write: { file: CLIP_FILES.write, tailSeconds: 9.5 } },
    };
    const manifestPath = path.join(temporaryDir, "ui-timing.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await loadClips(temporaryDir, validProbe, warn), {});
    await writeFile(path.join(temporaryDir, CLIP_FILES.write), "probe stub, not media");
    const clips = await loadClips(temporaryDir, validProbe, warn);
    assert.deepEqual(Object.keys(clips), ["write"]);
    assert.equal(clips.write.trimBefore, 302);
    assert.equal(clips.write.sourceFrames, 296);
    assert.equal(clips.write.playbackRate * 450, 296);
    await assert.rejects(loadClips(temporaryDir, async () => ({
      format: { duration: "20" },
      streams: [{ codec_type: "video", width: 800, height: 600 }],
    }), warn), /1920x1080/);
    manifest.clips.write.file = "../unexpected.webm";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadClips(temporaryDir, validProbe, warn), /Invalid write capture timing/);
    await writeFile(manifestPath, "{");
    await assert.rejects(loadClips(temporaryDir, validProbe, warn), SyntaxError);
    assert.ok(warnings.some((message) => message.includes("manifest")));
    assert.ok(warnings.some((message) => message.includes("missing")));
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
  const metadata = {
    format: { duration: "150.0" },
    streams: [{
      codec_type: "video", codec_name: "h264", width: WIDTH, height: HEIGHT,
      avg_frame_rate: "30/1",
    }],
  };
  assert.deepEqual(validateOutput(metadata), {
    seconds: 150, width: 1920, height: 1080, fps: 30, audioStreams: 0,
  });
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
    "http://user:password@localhost", "http://localhost/not-root",
  ]) {
    assert.throws(() => captureConfig({ JINAI_URL: url, JINAI_TOKEN: "disposable" }), /loopback/);
  }
  console.log("Rendering inputs verified: 150s timeline, 8 still frames, README-exact Cypher, missing/partial capture fallback, clip timing, output format guards, loopback-only capture.");
}

await verifyScenario();
await verifyRenderingInputs();
