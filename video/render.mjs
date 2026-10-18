import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTimeline, DURATION, FPS, FRAME_INDEXES, HEIGHT, MAX_SCENE_BYTES, WIDTH, validateFrameIndex } from "./src/timeline.mjs";

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

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    throw new Error("Capture frame is not a complete JPEG.");
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error("Capture JPEG has no supported size header.");
}

export async function loadClips(directory, warn = console.warn) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, "ui-timing.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    warn("No UI capture manifest: all four graph scenes will say RECORDING UNAVAILABLE.");
    return {};
  }
  if (
    manifest.version !== 2 || manifest.storage !== "memory" || manifest.embeddings !== "fake" ||
    !manifest.clips || typeof manifest.clips !== "object" || Array.isArray(manifest.clips)
  ) {
    throw new Error("Invalid UI capture manifest.");
  }
  const clips = {};
  for (const [id, indexFile] of Object.entries(FRAME_INDEXES)) {
    const timing = manifest.clips[id];
    if (!timing) {
      warn(`No ${id} capture: this scene will say RECORDING UNAVAILABLE.`);
      continue;
    }
    if (timing.index !== indexFile) {
      throw new Error(`Invalid ${id} capture timing.`);
    }
    let index;
    try {
      index = JSON.parse(await readFile(path.join(directory, indexFile), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      warn(`${indexFile} is missing: this scene will say RECORDING UNAVAILABLE.`);
      continue;
    }
    validateFrameIndex(index, id);
    const frameDirectory = path.dirname(path.join(directory, indexFile));
    let missing = false;
    let bytesRead = 0;
    for (const frame of index.frames) {
      let bytes;
      try {
        bytes = await readFile(path.join(frameDirectory, frame.file));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        warn(`${id}/${frame.file} is missing: this scene will say RECORDING UNAVAILABLE.`);
        missing = true;
        break;
      }
      const size = jpegDimensions(bytes);
      if (size.width !== WIDTH || size.height !== HEIGHT) {
        throw new Error(`${id}/${frame.file} must be a 1920x1080 JPEG.`);
      }
      bytesRead += bytes.length;
      if (bytesRead > MAX_SCENE_BYTES) throw new Error(`${id} exceeds its 64 MiB frame budget.`);
    }
    if (missing) continue;
    clips[id] = {
      directory: indexFile.slice(0, indexFile.lastIndexOf("/")),
      durationSeconds: index.durationSeconds, frames: index.frames,
    };
  }
  return clips;
}

export function validateOutput(metadata, expectedFrames = DURATION) {
  const stream = metadata.streams?.find((item) => item.codec_type === "video");
  const seconds = Number(metadata.format?.duration);
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = numerator / denominator;
  if (
    stream?.codec_name !== "h264" || stream?.width !== WIDTH || stream?.height !== HEIGHT ||
    Math.abs(fps - FPS) > 0.001 || !Number.isFinite(fps) ||
    !Number.isFinite(seconds) || Math.abs(seconds - expectedFrames / FPS) > 1 / FPS ||
    seconds < 120 || seconds > 180 ||
    metadata.streams.some((item) => item.codec_type === "audio")
  ) {
    throw new Error(`Output must be ${expectedFrames / FPS} seconds (2:00-3:00), 1920x1080, 30fps, with no audio stream.`);
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
  const props = { clips: await loadClips(publicDir) };
  const timeline = buildTimeline(props.clips);
  if (mode === "inspect") {
    const summary = validateOutput(await probe(path.join(out, "demo.mp4")), timeline.durationInFrames);
    await writeFile(path.join(out, "media-info.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const propsFile = path.join(out, "render-props.json");
  await writeFile(propsFile, `${JSON.stringify(props, null, 2)}\n`);
  const common = [
    "--props", propsFile, "--public-dir", publicDir, "--log", "info",
    "--concurrency", "2",
  ];
  if (mode === "render") {
    await remotion([
      "render", "src/index.jsx", "Demo", path.join(out, "demo.mp4"),
      ...common, "--codec", "h264", "--pixel-format", "yuv420p",
      "--image-format", "png", "--crf", "16", "--x264-preset", "veryfast", "--muted",
    ]);
  } else {
    const directory = path.join(out, "stills");
    await mkdir(directory, { recursive: true });
    const frames = timeline.scenes.map((scene) => scene.stillFrame);
    await remotion([
      "render", "src/index.jsx", "Demo", directory, ...common,
      "--frames", frames.join(","), "--image-format", "png",
    ]);
    const images = (await readdir(directory)).filter((file) => file.endsWith(".png"));
    if (images.length !== timeline.scenes.length) throw new Error("Expected exactly nine scene PNGs.");
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
      timeline.scenes.map((scene) => ({
        scene: scene.id, second: scene.stillFrame / FPS, frame: scene.stillFrame,
      })),
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
