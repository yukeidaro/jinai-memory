export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const INTRO_FRAMES = 5 * FPS;
export const CLOSING_FRAMES = 10 * FPS;
export const PENDING_FRAMES = 4 * FPS;
export const MAX_RECORDING_SECONDS = 25;
export const FADE_FRAMES = 0.4 * FPS;
export const CAPTION_FROM = 0.3 * FPS;

export const RECORDINGS = [
  {
    id: "install",
    file: "02-install.mp4",
    label: "Scene 2 \u2014 install (recording pending)",
    caption: "One command connects every AI tool on your machine.",
  },
  {
    id: "settings",
    file: "03-settings.mp4",
    label: "Scene 3 \u2014 settings (recording pending)",
    caption: "Claude and ChatGPT connect with one custom connector URL.",
  },
  {
    id: "chatgpt-claudecode",
    file: "04-chatgpt-claudecode.mp4",
    label: "Scene 4 \u2014 ChatGPT + Claude Code (recording pending)",
    caption: "ChatGPT and Claude Code write to one graph in FalkorDB.",
  },
  {
    id: "claude",
    file: "05-claude.mp4",
    label: "Scene 5 \u2014 Claude (recording pending)",
    caption: "Switch to Claude. Your memory comes with you.",
  },
];

export const EMPTY_DURATIONS = {
  version: 1,
  clips: Object.fromEntries(RECORDINGS.map(({ file }) => [file, null])),
};

export function buildFinalTimeline(manifest) {
  if (
    !manifest || manifest.version !== 1 || !manifest.clips ||
    typeof manifest.clips !== "object" || Array.isArray(manifest.clips)
  ) {
    throw new Error("Invalid final/durations.json: expected version 1 and a clips object.");
  }
  const scenes = [{ id: "intro", startFrame: 0, durationInFrames: INTRO_FRAMES }];
  let startFrame = INTRO_FRAMES;
  for (const recording of RECORDINGS) {
    const seconds = manifest.clips[recording.file];
    if (seconds !== null && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)) {
      throw new Error(`Invalid duration for ${recording.file}: expected positive seconds or null.`);
    }
    const pending = seconds === null;
    const durationInFrames = pending ? PENDING_FRAMES
      : Math.ceil(Math.min(seconds, MAX_RECORDING_SECONDS) * FPS);
    scenes.push({ ...recording, startFrame, durationInFrames, pending });
    startFrame += durationInFrames;
  }
  scenes.push({ id: "closing", startFrame, durationInFrames: CLOSING_FRAMES });
  return {
    scenes,
    durationInFrames: startFrame + CLOSING_FRAMES,
    stills: [
      { name: "intro.png", frame: 2 * FPS },
      { name: "closing.png", frame: startFrame + 2 * FPS },
    ],
  };
}
