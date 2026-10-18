import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const videoDir = fileURLToPath(new URL("./", import.meta.url));
const out = path.join(videoDir, "out");
const cli = path.join(videoDir, "node_modules", "@remotion", "cli", "remotion-cli.js");
const frames = [30, 200, 450, 650, 900, 1250, 1500, 1620];

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

export function validateOutput(metadata) {
  const stream = metadata.streams?.find((item) => item.codec_type === "video");
  const seconds = Number(metadata.format?.duration);
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number);
  const fps = numerator / denominator;
  const frameCount = Number(stream?.nb_read_frames);
  if (
    stream?.codec_name !== "h264" || stream?.width !== 1920 || stream?.height !== 1080 ||
    frameCount !== 1650 || fps !== 30 ||
    !Number.isFinite(seconds) || Math.abs(seconds - 55) > 1 / 30
  ) {
    throw new Error("Output must be 1650 frames, 55 seconds, 1920x1080, 30fps, encoded as H.264.");
  }
  return { frames: frameCount, seconds, width: stream.width, height: stream.height, fps };
}

export async function inspectOutput() {
  const output = await remotion([
    "ffprobe", "-v", "error", "-count_frames", "-show_format", "-show_streams",
    "-of", "json", path.join(out, "jinai-memory-demo-55s.mp4"),
  ], { collect: true });
  const summary = validateOutput(JSON.parse(output));
  await writeFile(path.join(out, "media-info-55s.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const mode = process.argv[2];
  if (!["render", "stills"].includes(mode)) {
    throw new Error("Usage: node render-teaser.mjs <render|stills>");
  }
  await mkdir(out, { recursive: true });
  if (mode === "render") {
    await remotion([
      "render", "src/index.jsx", "JinAIMemoryDemo", path.join(out, "jinai-memory-demo-55s.mp4"),
      "--codec", "h264", "--crf", "18",
    ]);
  } else {
    const directory = path.join(out, "stills-55s");
    await mkdir(directory, { recursive: true });
    for (const frame of frames) {
      await remotion([
        "still", "src/index.jsx", "JinAIMemoryDemo", path.join(directory, `f${frame}.png`),
        "--frame", String(frame),
      ]);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
