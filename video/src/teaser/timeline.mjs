export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const DURATION = 1650;
export const HOLD_FROM = 1560;

export const ACTS = [
  { id: "import", from: 0, to: 360 },
  { id: "chatgpt", from: 360, to: 720 },
  { id: "claude", from: 720, to: 1110 },
  { id: "falkordb", from: 1110, to: 1440 },
  { id: "closing", from: 1440, to: DURATION },
];

export const COPY = {
  command: "node scripts/import.mjs",
  confirm: " --yes",
  prompt: "Had burgers tonight. Always loved them.",
  question: "What should I have for dinner tomorrow?",
  acknowledgment: "Nice! Noted in Jin AI Memory:",
  answerBefore: "You just had burgers ",
  answerEmphasis: "yesterday",
  answerAfter: " - how about grilled salmon tonight?",
  repository: "github.com/yukeidaro/jinai-memory",
  query: "CALL db.idx.vector.queryNodes($label, $attribute, $candidates, vecf32($embedding)) YIELD node, score",
};

export const IMPORT_ROWS = [
  { label: "skills", value: "74" },
  { label: "memory files", value: "17" },
  { label: "CLAUDE.md sections", value: "16" },
  { label: "Claude Code sessions", value: "18" },
  { label: "secrets skipped", value: "0" },
];

export const WRITE_ROWS = [
  { label: "preference", value: "loves burgers", from: 470 },
  { label: "event", value: "Oct 17 dinner: burgers", from: 505 },
];

export const ENGINE_ROWS = [
  { text: "Write: vector index wires related notes (SIMILAR edges)", from: 1140 },
  { text: "Read: follow edges - no search every turn", from: 1200 },
  { text: "Entry map \u2264 400 tokens, even at 2,000 notes", from: 1260 },
];

export const CAPTIONS = [
  { id: "bring", from: 22, to: 170, lines: ["Bring the AI memory you already have."] },
  {
    id: "one-command", from: 170, to: 360,
    lines: ["Skills, memory files, CLAUDE.md and past Claude Code sessions", "- one command."],
  },
  {
    id: "automatic", from: 560, to: 720,
    lines: ["ChatGPT decides what's worth remembering.", "You never said 'save'."],
  },
  { id: "next-day", from: 720, to: 840, lines: ["The next day - a different AI."] },
  { id: "whole-memory", from: 1140, to: 1290, lines: ["FalkorDB is the whole memory."] },
  { id: "isolated", from: 1290, to: 1440, lines: ["Each user gets an isolated graph."] },
];

export const READABLES = [
  ...CAPTIONS,
  { id: "chatgpt-prompt", from: 372 + COPY.prompt.length, to: 720 },
  { id: "chatgpt-answer", from: 440, to: 720 },
  { id: "claude-question", from: 740 + COPY.question.length, to: 1110 },
  {
    id: "claude-answer",
    from: 840 + COPY.answerBefore.length + COPY.answerEmphasis.length + COPY.answerAfter.length,
    to: 1110,
  },
  { id: "read-by-claude", from: 1000, to: 1036 },
  { id: "read-by-mcp", from: 1051, to: 1110 },
  { id: "tagline", from: 1540, to: DURATION },
];

export const clamp01 = (value) => Math.max(0, Math.min(1, value));
export const progress = (frame, from, duration) => clamp01((frame - from) / duration);
export const mix = (from, to, amount) => from + (to - from) * amount;
export const repeatDuration = (index) => index < 2 ? 15 : 8;
export const typedCount = (frame, from, text) => Math.min(text.length, Math.max(0, Math.floor(frame - from)));
export const typedText = (frame, from, text) => text.slice(0, typedCount(frame, from, text));

export function actAt(frame) {
  return ACTS.find((act) => frame >= act.from && frame < act.to)?.id ?? null;
}

export function cameraAt(frame) {
  return {
    scale: 1.025 + Math.sin(frame / 45) * 0.0225,
    x: Math.sin(frame / 83) * 7,
    y: Math.cos(frame / 97) * 5,
  };
}

// These same drivers animate visible geometry in kit.jsx, not a second test-only schedule.
export function frameState(frame) {
  const live = Math.min(frame, HOLD_FROM);
  return {
    frame: live,
    camera: cameraAt(frame),
    dockEnter: progress(live, 0, 12),
    spawn: progress(live, 12, 9),
    command: typedCount(live, 22, COPY.command),
    cursor: Math.floor(live / 7) % 2,
    scan: progress(live, 60, 90),
    confirm: typedCount(live, 150, COPY.confirm),
    enter: progress(live, 158, 12),
    import: progress(live, 170, 130),
    graphDrift: Math.sin(live / 23),
    dim: progress(live, 300, 6),
    terminalTurn: progress(live, 360, 12),
    chatTyping: typedCount(live, 372, COPY.prompt),
    claudeTurn: progress(live, 720, 12),
    claudeTyping: typedCount(live, 740, COPY.question),
    read: progress(live, 800, 40),
    photon: ((live - 840) % 45 + 45) % 45 / 45,
    answer: typedCount(live, 840, COPY.answerBefore + COPY.answerEmphasis + COPY.answerAfter),
    minimize: progress(live, 1110, 12),
    expand: progress(live, 1122, 18),
    collapse: progress(live, 1440, 30),
    morph: progress(live, 1470, 10),
    repository: typedCount(live, 1480, COPY.repository),
    brand: progress(live, 1480, 60),
    tagline: progress(live, 1540, 20),
  };
}

export function motionAt(frame) {
  const now = frameState(frame);
  const next = frameState(frame + 1);
  const changed = (keys) => keys.some((key) => Math.abs(now[key] - next[key]) > 1e-7);
  let primary = [];
  if (frame < 12) primary = ["dockEnter"];
  else if (frame < 22) primary = ["spawn", "cursor"];
  else if (frame < 60) primary = ["command", "cursor"];
  else if (frame < 150) primary = ["scan"];
  else if (frame < 170) primary = ["confirm", "enter"];
  else if (frame < 300) primary = ["import"];
  else if (frame < 360) primary = ["dim", "graphDrift"];
  else if (frame < 372) primary = ["terminalTurn"];
  else if (frame < 440) primary = ["chatTyping", "cursor"];
  else if (frame < 720) primary = ["graphDrift"];
  else if (frame < 732) primary = ["claudeTurn"];
  else if (frame < 800) primary = ["claudeTyping", "cursor"];
  else if (frame < 840) primary = ["read"];
  else if (frame < 1000) primary = ["answer", "photon"];
  else if (frame < 1110) primary = ["photon"];
  else if (frame < 1122) primary = ["minimize"];
  else if (frame < 1140) primary = ["expand"];
  else if (frame < 1440) primary = ["photon"];
  else if (frame < 1470) primary = ["collapse"];
  else if (frame < 1480) primary = ["morph"];
  else if (frame < 1540) primary = ["repository", "brand"];
  else if (frame < HOLD_FROM) primary = ["tagline"];
  return { moving: changed(primary), drivers: primary };
}

export function stillRuns(duration = DURATION, motion = motionAt) {
  const runs = [];
  let from = null;
  for (let frame = 0; frame <= duration; frame += 1) {
    const still = frame < duration && !motion(frame).moving;
    if (still && from === null) from = frame;
    if (!still && from !== null) {
      runs.push({ from, to: frame, duration: frame - from });
      from = null;
    }
  }
  return runs;
}

export function validateTimeline({ acts = ACTS, captions = READABLES, motion = motionAt } = {}) {
  const errors = [];
  let end = 0;
  for (const act of acts) {
    if (!Number.isInteger(act.from) || !Number.isInteger(act.to) || act.from !== end || act.to <= act.from) {
      errors.push(`Invalid or non-contiguous act: ${act.id}`);
    }
    end = act.to;
  }
  if (end !== DURATION) errors.push(`Expected ${DURATION} frames, got ${end}`);
  for (const caption of captions) {
    if (!Number.isInteger(caption.from) || !Number.isInteger(caption.to) ||
        caption.from < 0 || caption.to > DURATION || caption.to - caption.from < 36) {
      errors.push(`Unreadable caption/answer: ${caption.id}`);
    }
  }
  const pauses = stillRuns(DURATION, motion);
  for (const pause of pauses) {
    if (pause.duration >= 15 && pause.from < HOLD_FROM) {
      errors.push(`Still for ${pause.duration} frames at ${pause.from}`);
    }
  }
  return { errors, duration: end, pauses, readableCount: captions.length };
}
