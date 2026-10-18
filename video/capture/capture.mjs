import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CLIP_FILES, HEIGHT, WIDTH } from "../src/timeline.mjs";
import { captureConfig, createDemoClient, dinnerMemories, seedMemories } from "./scenario.mjs";

const videoDir = fileURLToPath(new URL("../", import.meta.url));
const publicDir = path.join(videoDir, "public");
const manifestPath = path.join(publicDir, "ui-timing.json");
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
// At DPR 1, three -360 wheel events give ~1.74x zoom after Fit view, targeting 60-75% graph width.
const ZOOM_WHEEL_STEPS = 3;
const ZOOM_WHEEL_DELTA = -360;
let stage = "configuration";

async function fitAndZoom(page) {
  await page.locator("#fit-view").click();
  await pause(1_500);
  await page.mouse.move(WIDTH / 2, HEIGHT / 2);
  for (let step = 0; step < ZOOM_WHEEL_STEPS; step++) {
    await page.mouse.wheel(0, ZOOM_WHEEL_DELTA);
    await pause(250);
  }
  await page.mouse.move(WIDTH / 2, 100);
  await pause(1_000);
}

async function main() {
  const config = captureConfig(process.env);
  const client = createDemoClient(config);
  await mkdir(publicDir, { recursive: true });
  await Promise.all([
    rm(manifestPath, { force: true }),
    ...Object.values(CLIP_FILES).map((file) => rm(path.join(publicDir, file), { force: true })),
  ]);
  const manifest = { version: 1, storage: "memory", embeddings: "fake", clips: {} };
  const saveManifest = () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await saveManifest();

  stage = "checking the empty local demo graph";
  if ((await client.snapshot()).nodes.length) {
    throw new Error("Refusing to capture a nonempty graph. Start a fresh disposable server.");
  }
  stage = "seeding fictional notes";
  for (const { source, arguments: args } of seedMemories()) {
    await client.call(source, "remember", args);
  }
  console.log("Seeded 8 fictional notes across ChatGPT, Claude, Cursor and Copilot.");

  stage = "launching Chromium";
  const temporaryDir = await mkdtemp(path.join(videoDir, ".capture-"));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    async function record(id, action) {
      stage = `${id}: opening the live graph`;
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
        reducedMotion: "no-preference",
        colorScheme: "dark",
        recordVideo: { dir: temporaryDir, size: { width: WIDTH, height: HEIGHT } },
      });
      let video;
      let closed = false;
      try {
        const page = await context.newPage();
        video = page.video();
        if (!video) throw new Error("Playwright did not create a video recording.");
        page.setDefaultTimeout(45_000);
        const url = new URL("/", config.base);
        url.searchParams.set("token", config.token);
        await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await page.locator("#graph canvas").first().waitFor({ state: "visible" });
        await page.waitForFunction(() =>
          document.querySelector("#connection-dot")?.dataset.state === "live" &&
          document.querySelector("#graph-message")?.hidden === true &&
          /[1-9]\d* memories/.test(document.querySelector("#graph-count")?.textContent ?? ""),
        );
        await pause(5_000);
        stage = `${id}: fitting and enlarging the constellation`;
        await fitAndZoom(page);
        stage = `${id}: recording MCP operations`;
        const started = performance.now();
        await action(page);
        await page.waitForFunction(() =>
          document.querySelector("#graph-error")?.hidden === true &&
          document.querySelector("#event-error")?.hidden === true &&
          document.querySelector("#connection-dot")?.dataset.state === "live",
        );
        const tailSeconds = (performance.now() - started) / 1000;
        await context.close();
        closed = true;
        const file = CLIP_FILES[id];
        await video.saveAs(path.join(publicDir, file));
        manifest.clips[id] = { file, tailSeconds };
        await saveManifest();
        console.log(`Saved ${file}; ${tailSeconds.toFixed(2)} seconds of scene actions.`);
      } finally {
        if (!closed) await context.close();
        if (video) await video.delete();
      }
    }

    const [preference, event] = dinnerMemories();
    await record("write", async (page) => {
      await client.call("chatgpt", "remember", preference);
      await page.waitForFunction(() =>
        document.querySelector('#activity-list')?.textContent.includes("ChatGPT remember"),
      );
      await pause(3_500);
      await client.call("chatgpt", "remember", event);
      await page.waitForFunction(() =>
        document.querySelector('[data-source="chatgpt"] .source-count')?.textContent === "4",
      );
      await pause(4_000);
      await fitAndZoom(page);
      await pause(4_000);
    });

    await record("read", async (page) => {
      await client.call("claude", "orient");
      await pause(1_000);
      await client.call("claude", "open", { title: preference.title });
      await pause(1_000);
      const opened = await client.call("claude", "open", { title: event.title });
      if (opened.note.source !== "chatgpt" || opened.note.kind !== "event" || opened.note.days_ago !== 1) {
        throw new Error("Dinner provenance or relative date did not match the demo.");
      }
      await page.waitForFunction(() =>
        document.querySelector("#activity-list")?.textContent.includes("Claude open"),
      );
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
      await pause(1_500);
      await pause(8_000);
    });

    await record("group", async (page) => {
      const toggle = page.locator("#split-toggle");
      await toggle.click();
      await page.locator('#split-toggle[aria-pressed="true"]').waitFor();
      await pause(8_000);
      stage = "group: fitting all four separated AI clusters";
      await fitAndZoom(page);
      await pause(7_000);
      await page.locator('#split-toggle[aria-pressed="true"]').waitFor();
      await toggle.click();
      await page.locator('#split-toggle[aria-pressed="false"]').waitFor();
      await pause(3_000);
    });
  } finally {
    try {
      if (browser) await browser.close();
    } finally {
      await rm(temporaryDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`Capture failed during ${stage} (${error instanceof Error ? error.name : "unknown error"}).`);
  console.error("Raw browser errors and token-bearing URLs are intentionally withheld. Check local health, CDN access, WebGL and the named stage.");
  process.exitCode = 1;
});
