import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIP_FILES, DURATION, FPS, HEIGHT, SCENES, WIDTH } from "./src/timeline.mjs";

const videoDir = fileURLToPath(new URL("./", import.meta.url));
const publicDir = path.join(videoDir, "public");
const cli = path.join(videoDir, "node_modules", "@remotion", "cli", "remotion-cli.js");

function remotion(args, { collect = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: videoDir,
      stdio: collect ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let output = "";
    if (collect) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.pipe(process.stderr);
    }
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Remotion ${args[0]} failed (exit ${code}).`));
    });
  });
}

async function probe(file) {
  const output = await remotion([
    "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", file,
  ], { collect: true });
  return JSON.parse(output);
}

export async function loadClips(directory, probeFile = probe, warn = console.warn) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, "ui-timing.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    warn("No UI capture manifest: all three graph scenes will say RECORDING UNAVAILABLE.");
    return {};
  }
  if (
    manifest.version !== 1 || manifest.storage !== "memory" || manifest.embeddings !== "fake" ||
    !manifest.clips || typeof manifest.clips !== "object" || Array.isArray(manifest.clips)
  ) {
    throw new Error("Invalid UI capture manifest.");
  }
  const clips = {};
  for (const [id, file] of Object.entries(CLIP_FILES)) {
    const timing = manifest.clips[id];
    if (!timing) {
      warn(`No ${id} capture: this scene will say RECORDING UNAVAILABLE.`);
      continue;
    }
    if (
      timing.file !== file || !Number.isFinite(timing.tailSeconds) ||
      timing.tailSeconds <= 0 || timing.tailSeconds > 120
    ) {
      throw new Error(`Invalid ${id} capture timing.`);
    }
    const filename = path.join(directory, file);
    try {
      if (!(await stat(filename)).isFile()) throw new Error(`${file} is not a file.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      warn(`${file} is missing: this scene will say RECORDING UNAVAILABLE.`);
      continue;
    }
    const metadata = await probeFile(filename);
    const stream = metadata.streams?.find((item) => item.codec_type === "video");
    const seconds = Number(metadata.format?.duration);
    if (
      stream?.width !== WIDTH || stream?.height !== HEIGHT ||
      !Number.isFinite(seconds) || seconds <= 0
    ) {
      throw new Error(`${file} must be a valid 1920x1080 recording with a duration.`);
    }
    // Tail anchoring discards variable navigation/CDN startup time. Leave two end frames as a decode guard.
    const end = Math.floor(seconds * FPS) - 2;
    const sourceFrames = Math.ceil((timing.tailSeconds + 0.35) * FPS);
    if (end < sourceFrames) throw new Error(`${file} is shorter than its recorded actions.`);
    const sceneFrames = SCENES.find((scene) => scene.id === id).seconds * FPS;
    clips[id] = {
      file, trimBefore: end - sourceFrames, sourceFrames,
      playbackRate: sourceFrames / sceneFrames,
    };
  }
  return clips;
}

export function validateOutput(metadata) {
  const stream = metadata.streams?.find((item) => item.codec_type === "video");
  const seconds = Number(metadata.format?.duration);
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = numerator / denominator;
  if (
    stream?.codec_name !== "h264" || stream?.width !== WIDTH || stream?.height !== HEIGHT ||
    Math.abs(fps - FPS) > 0.001 || !Number.isFinite(fps) ||
    !Number.isFinite(seconds) || Math.abs(seconds - DURATION / FPS) > 1 / FPS ||
    metadata.streams.some((item) => item.codec_type === "audio")
  ) {
    throw new Error("Output must be 150 seconds, 1920x1080, 30fps, with no audio stream.");
  }
  return { seconds, width: stream.width, height: stream.height, fps, audioStreams: 0 };
}

async function main() {
  const mode = process.argv[2];
  if (!["render", "stills", "inspect"].includes(mode)) {
    throw new Error("Usage: node render.mjs <render|stills|inspect>");
  }
  const out = path.join(videoDir, "out");
  await mkdir(out, { recursive: true });
  if (mode === "inspect") {
    const summary = validateOutput(await probe(path.join(out, "demo.mp4")));
    await writeFile(path.join(out, "media-info.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const props = { clips: await loadClips(publicDir) };
  const propsFile = path.join(out, "render-props.json");
  await writeFile(propsFile, `${JSON.stringify(props, null, 2)}\n`);
  const common = [
    "--props", propsFile, "--public-dir", publicDir, "--log", "info",
    "--concurrency", "2", "--offthreadvideo-video-threads", "1",
    "--offthreadvideo-cache-size-in-bytes", "268435456",
  ];
  if (mode === "render") {
    await remotion([
      "render", "src/index.jsx", "Demo", path.join(out, "demo.mp4"),
      ...common, "--codec", "h264", "--pixel-format", "yuv420p",
      "--crf", "20", "--x264-preset", "veryfast", "--muted",
    ]);
  } else {
    const directory = path.join(out, "stills");
    await mkdir(directory, { recursive: true });
    const frames = SCENES.map((scene) => scene.still * FPS);
    await remotion([
      "render", "src/index.jsx", "Demo", directory, ...common,
      "--frames", frames.join(","), "--image-format", "png",
    ]);
    const images = (await readdir(directory)).filter((file) => file.endsWith(".png"));
    if (images.length !== SCENES.length) throw new Error("Expected exactly eight scene PNGs.");
    for (const file of images) {
      const bytes = await readFile(path.join(directory, file));
      if (
        bytes.length < 24 || bytes.readUInt32BE(16) !== WIDTH ||
        bytes.readUInt32BE(20) !== HEIGHT
      ) {
        throw new Error(`${file} is not a 1920x1080 PNG.`);
      }
    }
    await writeFile(path.join(out, "still-index.json"), `${JSON.stringify(
      SCENES.map((scene) => ({ scene: scene.id, second: scene.still, frame: scene.still * FPS })),
      null, 2,
    )}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
