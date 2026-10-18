import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FPS, FRAME_INDEXES, HEIGHT, MAX_SCENE_BYTES, WIDTH, validateFrameIndex } from "../src/timeline.mjs";
import { captureConfig, createDemoClient, dinnerMemories, seedMemories } from "./scenario.mjs";

const videoDir = fileURLToPath(new URL("../", import.meta.url));
const publicDir = path.join(videoDir, "public");
const manifestPath = path.join(publicDir, "ui-timing.json");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const JPEG_QUALITY = 94;
export const FRAME_INTERVAL = 0.125;
// Zoom out slightly and pan 120 CSS pixels right so the fitted 2D graph clears the 318px-wide legend.
const FRAMING = { wheelDelta: 220, panRight: 120 };
const DETAIL_HOLD_MS = 6_500;
const GROUP_HOLD_MS = 6_500;
let stage = "configuration";

export async function startFrameCapture(page, directory, id, {
  warn = console.warn,
  firstFrameTimeout = 5_000,
  clock = () => performance.now() / 1000,
} = {}) {
  await mkdir(directory, { recursive: true });
  const frames = [];
  let bytesWritten = 0;
  let started;
  let failure;
  let stopped = false;
  let saving = Promise.resolve();
  let busy = false;
  let session;
  let listener;
  let cdpRunning = false;
  let originTimestamp;
  let unavailable;
  const acknowledgements = new Set();

  async function save(bytes, time) {
    if (frames.length && time - frames.at(-1).time < FRAME_INTERVAL) return;
    if (!Number.isFinite(time) || time < 0) throw new Error("Invalid capture timestamp.");
    if (bytesWritten + bytes.length > MAX_SCENE_BYTES) {
      throw new Error("Capture exceeded its 64 MiB scene budget. Reduce capture cadence or waits.");
    }
    const file = `${String(frames.length + 1).padStart(6, "0")}.jpg`;
    await writeFile(path.join(directory, file), bytes);
    frames.push({ file, time });
    bytesWritten += bytes.length;
  }

  async function closeCDP() {
    if (!session) return;
    try {
      if (cdpRunning) await session.send("Page.stopScreencast");
      await Promise.all(acknowledgements);
    } finally {
      session.off("Page.screencastFrame", listener);
      await session.detach();
      session = undefined;
    }
  }

  try {
    session = await page.context().newCDPSession(page);
    listener = (event) => {
      const acknowledgement = session.send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch((error) => { failure = error; })
        .finally(() => acknowledgements.delete(acknowledgement));
      acknowledgements.add(acknowledgement);
      if (stopped || busy || failure) return;
      const timestamp = event.metadata?.timestamp;
      if (!Number.isFinite(timestamp)) {
        const error = new Error("CDP did not supply frame timestamps.");
        if (originTimestamp === undefined) unavailable = error;
        else failure = error;
        return;
      }
      if (originTimestamp === undefined) {
        originTimestamp = timestamp;
        started = clock();
      }
      busy = true;
      saving = save(Buffer.from(event.data, "base64"), timestamp - originTimestamp)
        .catch((error) => { failure = error; })
        .finally(() => { busy = false; });
    };
    session.on("Page.screencastFrame", listener);
    await session.send("Page.startScreencast", {
      format: "jpeg", quality: JPEG_QUALITY,
      maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1,
    });
    cdpRunning = true;
    const deadline = performance.now() + firstFrameTimeout;
    while (!frames.length && !failure && !unavailable && performance.now() < deadline) await pause(10);
    if (failure) throw failure;
    if (unavailable || !frames.length) throw unavailable ?? new Error("CDP sent no frames.");
  } catch (error) {
    await closeCDP();
    await saving;
    if (failure || frames.length) throw failure ?? error;
    unavailable = error;
  }

  const capture = unavailable ? "screenshot" : "cdp";
  if (unavailable) {
    warn(`CDP screencast unavailable (${unavailable.name}); using timestamped JPEG screenshots.`);
    await save(await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, scale: "css" }), 0);
    started = clock();
    saving = (async () => {
      while (!stopped) {
        await pause(FRAME_INTERVAL * 1000);
        if (stopped) break;
        const time = clock() - started;
        const bytes = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, scale: "css" });
        if (!stopped) await save(bytes, time);
      }
    })().catch((error) => { failure = error; });
  }

  return {
    async stop({ publish = true } = {}) {
      const duration = clock() - started;
      stopped = true;
      await closeCDP();
      await saving;
      if (failure) throw failure;
      const index = {
        version: 1, scene: id, width: WIDTH, height: HEIGHT,
        capture, quality: JPEG_QUALITY, bytes: bytesWritten,
        durationSeconds: Math.max(duration, frames.at(-1).time + 1 / FPS),
        frames,
      };
      validateFrameIndex(index, id);
      if (publish) await writeFile(path.join(directory, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
      return index;
    },
  };
}

async function healthy(page) {
  await page.waitForFunction(() =>
    ["graph-error", "event-error", "view-error"].every((id) => document.getElementById(id)?.hidden === true) &&
    document.querySelector("#connection-dot")?.dataset.state === "live",
  );
}

async function fit2D(page) {
  await page.locator("#fit-view").click();
  await pause(1_200);
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  await page.mouse.wheel(0, FRAMING.wheelDelta);
  await pause(300);
  // The empty upper canvas avoids dragging a node or touching the toolbar/browser.
  await page.mouse.move(600, 180);
  await page.mouse.down();
  await page.mouse.move(600 + FRAMING.panRight, 180, { steps: 12 });
  await page.mouse.up();
  await page.mouse.move(WIDTH / 2, 100);
  await pause(700);
}

async function main() {
  const config = captureConfig(process.env);
  const client = createDemoClient(config);
  await mkdir(publicDir, { recursive: true });
  await rm(manifestPath, { force: true });
  for (const index of Object.values(FRAME_INDEXES)) {
    await rm(path.dirname(path.join(publicDir, index)), { recursive: true, force: true });
  }
  const manifest = { version: 2, storage: "memory", embeddings: "fake", clips: {} };
  const saveManifest = () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await saveManifest();

  stage = "checking the empty local demo graph";
  if ((await client.snapshot()).nodes.length) {
    throw new Error("Refusing to capture a nonempty graph. Start a fresh disposable server.");
  }
  stage = "seeding fictional notes";
  for (const { source, arguments: args } of seedMemories()) await client.call(source, "remember", args);
  console.log("Seeded 8 fictional notes across ChatGPT, Claude, Cursor and Copilot.");

  stage = "launching Chromium";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  try {
    async function record(page, id, action) {
      stage = `${id}: starting timestamped high-quality frames`;
      const indexPath = FRAME_INDEXES[id];
      const recorder = await startFrameCapture(page, path.dirname(path.join(publicDir, indexPath)), id);
      let finished = false;
      try {
        stage = `${id}: recording scene actions`;
        await action();
        await healthy(page);
        finished = true;
        const index = await recorder.stop();
        manifest.clips[id] = { index: indexPath };
        await saveManifest();
        console.log(`Saved ${id}: ${index.frames.length} JPEGs, ${index.durationSeconds.toFixed(2)}s, ${(index.bytes / 1024 / 1024).toFixed(1)} MiB (${index.capture}).`);
      } finally {
        if (!finished) await recorder.stop({ publish: false });
      }
    }

    async function with2DPage(id, action) {
      stage = `${id}: opening the live 2D graph`;
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1, reducedMotion: "no-preference", colorScheme: "dark",
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(45_000);
        const url = new URL("/", config.base);
        url.searchParams.set("token", config.token);
        url.searchParams.set("view", "2d");
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await page.locator("#graph2d canvas").waitFor({ state: "visible" });
        await page.locator('#view-toggle[aria-pressed="true"]').waitFor();
        await page.waitForFunction(() =>
          document.querySelector("#graph-message")?.hidden === true &&
          /[1-9]\d* memories/.test(document.querySelector("#graph-count")?.textContent ?? ""),
        );
        await healthy(page);
        await pause(4_500);
        await fit2D(page);
        await action(page);
      } finally {
        await context.close();
      }
    }

    const [preference, event] = dinnerMemories();
    await with2DPage("write", async (page) => {
      await record(page, "write", async () => {
        await pause(700);
        await client.call("chatgpt", "remember", preference);
        await page.waitForFunction(() =>
          document.querySelector('[data-source="chatgpt"] .source-count')?.textContent === "3",
        );
        await pause(2_500);
        await client.call("chatgpt", "remember", event);
        await page.waitForFunction(() =>
          document.querySelector('[data-source="chatgpt"] .source-count')?.textContent === "4",
        );
        await pause(4_000);
        await fit2D(page);
        await pause(4_000);
      });
    });

    await with2DPage("read", async (page) => {
      await record(page, "read", async () => {
        await client.call("claude", "orient");
        await pause(800);
        await client.call("claude", "open", { title: preference.title });
        await pause(800);
        const opened = await client.call("claude", "open", { title: event.title });
        if (opened.note.source !== "chatgpt" || opened.note.kind !== "event" || opened.note.days_ago !== 1) {
          throw new Error("Dinner provenance or relative date did not match the demo.");
        }
        await page.waitForFunction(() =>
          document.querySelector("#activity-list")?.textContent.includes("Claude open"),
        );
        await pause(900);
        stage = "read: selecting the dinner event and checking its visible details";
        await page.locator("#browse-toggle").click();
        await page.locator("#memory-list").getByRole("button", {
          name: `${event.title} ChatGPT · event`, exact: true,
        }).click();
        await page.waitForFunction(({ title, summary, occurredAt }) =>
          document.querySelector("#details")?.hidden === false &&
          document.querySelector("#detail-title")?.textContent === title &&
          document.querySelector("#detail-source")?.textContent === "ChatGPT" &&
          document.querySelector("#detail-kind")?.textContent === "event" &&
          document.querySelector("#detail-summary")?.textContent === summary &&
          document.querySelector("#detail-date")?.getAttribute("datetime") === occurredAt &&
          document.querySelector("#detail-body")?.textContent.includes("デミグラスソースのハンバーグを作り"),
        event);
        await page.locator("#browse-toggle").click();
        await page.locator("#browser").waitFor({ state: "hidden" });
        await page.locator("#details").waitFor({ state: "visible" });
        await page.mouse.move(WIDTH / 2, 100);
        await pause(1_000);
        await pause(DETAIL_HOLD_MS);
      });
    });

    await with2DPage("group", async (page) => {
      await record(page, "group", async () => {
        await page.locator("#split-toggle").click();
        await page.locator('#split-toggle[aria-pressed="true"]').waitFor();
        await pause(5_000);
        stage = "group: fitting all four separated AI clusters";
        await fit2D(page);
        await pause(GROUP_HOLD_MS);
        await page.locator('#split-toggle[aria-pressed="true"]').waitFor();
      });
      stage = "ui-3d: switching the same graph from 2D to 3D";
      await page.locator("#view-toggle").click();
      await page.locator('#view-toggle[aria-pressed="false"]').waitFor();
      await page.locator("#graph3d canvas").waitFor({ state: "visible" });
      await healthy(page);
      await pause(4_000);
      await page.locator("#fit-view").click();
      await pause(1_200);
      await page.mouse.move(WIDTH / 2, 100);
      await record(page, "ui-3d", () => pause(3_500));
    });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Capture failed during ${stage} (${error instanceof Error ? error.name : "unknown error"}).`);
    console.error("Raw browser errors and token-bearing URLs are intentionally withheld. Check local health, CDN access, WebGL and the named stage.");
    process.exitCode = 1;
  });
}
