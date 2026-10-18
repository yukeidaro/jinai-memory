import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeMedia } from "./measure-final.mjs";
import { buildFinalTimeline, FPS, HEIGHT, WIDTH } from "./src/final/timeline.mjs";

const videoDir = fileURLToPath(new URL("./", import.meta.url));
const out = path.join(videoDir, "out");
const cli = path.join(videoDir, "node_modules", "@remotion", "cli", "remotion-cli.js");

function remotion(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: videoDir, stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Remotion ${args[0]} failed (exit ${code}).`));
    });
  });
}

export function validateFinalOutput(metadata, expectedFrames) {
  const stream = metadata.streams?.find((item) => item.codec_type === "video");
  const audioStreams = metadata.streams?.filter((item) => item.codec_type === "audio").length ?? 0;
  const [numerator, denominator] = (stream?.avg_frame_rate ?? "").split("/").map(Number);
  const seconds = Number(metadata.format?.duration);
  if (
    stream?.codec_name !== "h264" || stream?.width !== WIDTH || stream?.height !== HEIGHT ||
    numerator / denominator !== FPS || Number(stream?.nb_read_frames) !== expectedFrames ||
    !Number.isFinite(seconds) || Math.abs(seconds - expectedFrames / FPS) > 1 / FPS ||
    audioStreams !== 1
  ) {
    throw new Error(`Final output must be ${expectedFrames} frames, 1920x1080, 30fps, H.264, with exactly one audio stream.`);
  }
  return { frames: expectedFrames, seconds, width: WIDTH, height: HEIGHT, fps: FPS, audioStreams };
}

async function main() {
  const mode = process.argv[2];
  if (!["render", "stills"].includes(mode)) {
    throw new Error("Usage: node render-final.mjs <render|stills>");
  }
  const manifest = JSON.parse(await readFile(path.join(videoDir, "public", "final", "durations.json"), "utf8"));
  const timeline = buildFinalTimeline(manifest);
  await mkdir(out, { recursive: true });
  const common = ["--public-dir", path.join(videoDir, "public"), "--concurrency", "2"];
  if (mode === "render") {
    const output = path.join(out, "jinai-memory-final.mp4");
    await remotion([
      "render", "src/index.jsx", "JinAIMemoryFinal", output, ...common,
      "--codec", "h264", "--pixel-format", "yuv420p", "--image-format", "png",
      "--crf", "18", "--x264-preset", "veryfast",
    ]);
    const summary = validateFinalOutput(await probeMedia(output, { countFrames: true }), timeline.durationInFrames);
    await writeFile(path.join(out, "media-info-final.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const directory = path.join(out, "stills-final");
    await mkdir(directory, { recursive: true });
    for (const { name, frame } of timeline.stills) {
      await remotion([
        "still", "src/index.jsx", "JinAIMemoryFinal", path.join(directory, name),
        ...common, "--frame", String(frame),
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
