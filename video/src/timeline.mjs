export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
export const MAX_SCENE_BYTES = 64 * 1024 * 1024;

export const FRAME_INDEXES = {
  write: "frames/ui-write/index.json",
  read: "frames/ui-read/index.json",
  group: "frames/ui-group/index.json",
  "ui-3d": "frames/ui-3d/index.json",
};

const SCENE_DEFAULTS = [
  { id: "intro", seconds: 10, still: 5 },
  { id: "chatgpt", seconds: 25, still: 18 },
  { id: "write", seconds: 18 },
  { id: "claude", seconds: 30, still: 21 },
  { id: "read", seconds: 18 },
  { id: "group", seconds: 18 },
  { id: "ui-3d", seconds: 3.5 },
  { id: "falkordb", seconds: 30, still: 15 },
  { id: "outro", seconds: 10, still: 5 },
];

export function buildTimeline(clips = {}) {
  let startFrame = 0;
  const scenes = SCENE_DEFAULTS.map((scene) => {
    const captured = clips[scene.id]?.durationSeconds;
    if (captured !== undefined && (!Number.isFinite(captured) || captured <= 0)) {
      throw new Error(`Invalid ${scene.id} capture duration.`);
    }
    if (scene.id === "ui-3d" && captured !== undefined && (captured < 3 || captured > 4)) {
      throw new Error("The 3D glimpse must contain 3-4 seconds of footage.");
    }
    const durationInFrames = Math.max(scene.seconds * FPS, Math.ceil((captured ?? 0) * FPS));
    const stillOffset = scene.still === undefined
      ? Math.min(durationInFrames - FPS, Math.round((captured ?? scene.seconds) * FPS) - FPS)
      : scene.still * FPS;
    const result = {
      id: scene.id, startFrame, durationInFrames,
      stillFrame: startFrame + Math.max(1, stillOffset),
    };
    startFrame += durationInFrames;
    return result;
  });
  if (startFrame < 120 * FPS || startFrame > 180 * FPS) {
    throw new Error("The measured timeline must be 2:00-3:00. Shorten capture waits; footage will not be sped up or cut.");
  }
  return { scenes, durationInFrames: startFrame };
}

export const { scenes: SCENES, durationInFrames: DURATION } = buildTimeline();

export function validateFrameIndex(index, id) {
  if (
    index?.version !== 1 || index.scene !== id ||
    index.width !== WIDTH || index.height !== HEIGHT ||
    !["cdp", "screenshot"].includes(index.capture) ||
    !Number.isInteger(index.quality) || index.quality < 92 || index.quality > 100 ||
    !Number.isFinite(index.durationSeconds) || index.durationSeconds <= 0 || index.durationSeconds > 75 ||
    !Array.isArray(index.frames) || !index.frames.length
  ) {
    throw new Error(`Invalid ${id} frame index (expected timestamped 1920x1080 JPEGs).`);
  }
  let previous = -1;
  for (const [position, frame] of index.frames.entries()) {
    if (
      frame.file !== `${String(position + 1).padStart(6, "0")}.jpg` ||
      !Number.isFinite(frame.time) || frame.time < 0 ||
      (position === 0 && frame.time !== 0) || frame.time <= previous ||
      frame.time >= index.durationSeconds
    ) {
      throw new Error(`Invalid ${id} frame timestamp or filename.`);
    }
    previous = frame.time;
  }
  if (id === "ui-3d" && (index.durationSeconds < 3 || index.durationSeconds > 4)) {
    throw new Error("The 3D glimpse must contain 3-4 seconds of footage.");
  }
}

// Hold the latest captured image, not a frame-count-based or interpolated approximation.
export function frameAtTime(frames, seconds) {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle].time <= seconds) low = middle;
    else high = middle - 1;
  }
  return frames[low];
}

export const CYPHER = [
  {
    title: "01 / Index the memory",
    explanation: "A cosine vector index on Memory.embedding.",
    code: [
      "CREATE VECTOR INDEX FOR (n:Memory) ON (n.embedding)",
      "OPTIONS {dimension: $dim, similarityFunction: $similarity}",
    ].join("\n"),
  },
  {
    title: "02 / Wire on write",
    explanation: "Find related notes when a new memory is saved.",
    code: [
      "CALL db.idx.vector.queryNodes($label, $attribute, $candidates, vecf32($embedding))",
      "YIELD node, score",
      "WHERE any(label IN labels(node) WHERE label IN $labels)",
      "RETURN node, score ORDER BY score ASC LIMIT $k",
    ].join("\n"),
  },
  {
    title: "03 / Follow on read",
    explanation: "Traverse neighboring nodes in either direction.",
    code: [
      "MATCH (a {id: $id})-[r]-(n)",
      "WHERE type(r) IN $types",
      "RETURN DISTINCT n, r, startNode(r).id, endNode(r).id",
      "ORDER BY coalesce(r.w, 0) DESC, n.id LIMIT $limit",
    ].join("\n"),
  },
];
