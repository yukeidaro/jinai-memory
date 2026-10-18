import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildFinalTimeline, FPS, RECORDINGS } from "./src/final/timeline.mjs";

const execute = promisify(execFile);
const finalDir = fileURLToPath(new URL("./public/final/", import.meta.url));

export async function probeMedia(file, { countFrames = false } = {}) {
  const { stdout } = await execute("ffprobe", [
    "-v", "error", ...(countFrames ? ["-count_frames"] : []),
    "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,nb_read_frames,duration:format=duration",
    "-of", "json", file,
  ]);
  return JSON.parse(stdout);
}

export function recordingSeconds(metadata, file) {
  const video = metadata.streams?.find((stream) => stream.codec_type === "video");
  const streamSeconds = Number(video?.duration);
  const seconds = Number.isFinite(streamSeconds) && streamSeconds > 0
    ? streamSeconds : Number(metadata.format?.duration);
  if (!video || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Cannot measure ${file}: expected a video stream with a positive duration.`);
  }
  return seconds;
}

export async function measureFinalRecordings(directory = finalDir) {
  const manifest = { version: 1, clips: {} };
  await mkdir(directory, { recursive: true });
  for (const { file } of RECORDINGS) {
    const filename = path.join(directory, file);
    let info;
    try {
      info = await stat(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      manifest.clips[file] = null;
      console.warn(`${file}: recording pending; using a 4-second placeholder.`);
      continue;
    }
    if (!info.isFile()) throw new Error(`${file} must be a recording file.`);
    manifest.clips[file] = recordingSeconds(await probeMedia(filename), file);
    console.log(`${file}: ${manifest.clips[file]} seconds (playback capped at 25 seconds).`);
  }
  const timeline = buildFinalTimeline(manifest);
  await writeFile(path.join(directory, "durations.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Final timeline: ${timeline.durationInFrames} frames / ${timeline.durationInFrames / FPS} seconds.`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  measureFinalRecordings().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
