export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const SCENES = [
  { id: "intro", start: 0, seconds: 10, still: 5 },
  { id: "chatgpt", start: 10, seconds: 25, still: 28 },
  { id: "write", start: 35, seconds: 20, still: 42 },
  { id: "claude", start: 55, seconds: 30, still: 76 },
  { id: "read", start: 85, seconds: 20, still: 100 },
  { id: "group", start: 105, seconds: 25, still: 123 },
  { id: "falkordb", start: 130, seconds: 30, still: 145 },
  { id: "outro", start: 160, seconds: 10, still: 165 },
];

export const DURATION = 170 * FPS;
export const CLIP_FILES = {
  write: "ui-write.webm",
  read: "ui-read.webm",
  group: "ui-group.webm",
};

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
