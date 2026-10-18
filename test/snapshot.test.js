import assert from "node:assert/strict";
import test from "node:test";
import { createEmbedder } from "../src/embedder.js";
import { createMemory } from "../src/memory.js";
import { buildSnapshot } from "../src/snapshot.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const AT = "2026-10-17T03:00:00.000Z";
const now = () => new Date(AT);

function setup(t) {
  const store = createMemoryStore();
  t.after(() => store.close());
  const memory = createMemory({ store, embedder: createEmbedder({ provider: "fake", dim: 128 }), now });
  return { store, memory };
}

test("snapshot returns the exact empty API shape and an injected generation time", async (t) => {
  const { store } = setup(t);
  assert.deepEqual(await buildSnapshot({ store, user: "demo", now }), {
    user: "demo", generatedAt: AT, nodes: [], links: [],
  });
});

test("snapshot maps real memories, Topics, Sources, tags, dates, and default weights", async (t) => {
  const { store, memory } = setup(t);
  const saved = await memory.remember({
    user: "demo", source: "chatgpt", kind: "event", title: "夕飯",
    text: "# 夕飯\nハンバーグ", summary: "昨日の夕飯",
    occurredAt: "2026-10-16T03:00:00.000Z", tags: ["夕飯", "晩ごはん", "夕飯"],
  });
  const snapshot = await buildSnapshot({ store, user: "demo", now });
  assert.deepEqual(Object.keys(snapshot).sort(), ["generatedAt", "links", "nodes", "user"]);
  assert.equal(snapshot.nodes.length, 4);
  assert.equal(snapshot.links.length, 3);
  assert.deepEqual(snapshot.nodes.find((node) => node.id === saved.id), {
    id: saved.id, type: "memory", label: "夕飯", kind: "event", source: "chatgpt",
    summary: "昨日の夕飯", text: "# 夕飯\nハンバーグ", tags: ["夕飯", "晩ごはん"],
    createdAt: AT, occurredAt: "2026-10-16T03:00:00.000Z",
  });
  for (const node of snapshot.nodes.filter((node) => node.type !== "memory")) {
    assert.deepEqual(node, {
      id: node.id, type: node.type, label: node.label, kind: null, source: null,
      summary: "", text: "", tags: [], createdAt: AT, occurredAt: null,
    });
  }
  assert.equal(snapshot.nodes.find((node) => node.type === "source").label, "chatgpt");
  assert.ok(snapshot.links.every((link) => link.w === 1));
  assert.ok(snapshot.links.every((link) => link.source === saved.id));
  assert.equal(JSON.stringify(snapshot).includes("embedding"), false);
});

test("snapshot keeps the newest 500 memories but every Topic and Source, including isolated ones", async (t) => {
  const { store } = setup(t);
  for (let index = 0; index < 505; index += 1) {
    const createdAt = new Date(Date.parse(AT) + index * 1_000).toISOString();
    for (const label of ["Memory", "Topic", "Source"]) {
      await store.upsertNode({
        user: "demo", id: `${label}-${index}`, labels: [label],
        props: label === "Memory"
          ? { title: `Memory ${index}`, text: "", kind: "fact", source: "claude", createdAt }
          : { name: `${label} ${index}`, createdAt },
      });
    }
  }
  for (const [from, to, type] of [
    ["Memory-504", "Memory-0", "SIMILAR"],
    ["Memory-0", "Topic-0", "ABOUT"],
    ["Memory-504", "Topic-0", "ABOUT"],
    ["Memory-504", "Source-0", "MENTIONED_BY"],
  ]) await store.addEdge({ user: "demo", from, to, type });
  const snapshot = await buildSnapshot({ store, user: "demo", now });
  assert.equal(snapshot.nodes.length, 1_510);
  assert.deepEqual(
    snapshot.nodes.filter((node) => node.type === "memory").map((node) => node.id),
    Array.from({ length: 500 }, (_, index) => `Memory-${504 - index}`),
  );
  assert.equal(snapshot.nodes.filter((node) => node.type === "topic").length, 505);
  assert.equal(snapshot.nodes.filter((node) => node.type === "source").length, 505);
  assert.equal(snapshot.links.length, 2);
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  assert.equal(ids.size, snapshot.nodes.length);
  assert.ok(snapshot.links.every((link) => ids.has(link.source) && ids.has(link.target)));
  assert.deepEqual(snapshot.nodes[0].tags, ["Topic 0"]);
});

test("snapshot deduplicates both-direction traversal without losing edge types, direction, or zero weight", async (t) => {
  const { store } = setup(t);
  for (const [id, label] of [["a", "Memory"], ["b", "Memory"], ["topic", "Topic"], ["source", "Source"]]) {
    await store.upsertNode({
      user: "demo", id, labels: [label],
      props: { title: id, name: id, createdAt: AT },
    });
  }
  const edges = [
    { from: "a", to: "topic", type: "ABOUT" },
    { from: "a", to: "source", type: "MENTIONED_BY" },
    { from: "b", to: "a", type: "SIMILAR", props: { w: 0.25 } },
    { from: "a", to: "b", type: "SIMILAR", props: { w: 0 } },
    { from: "a", to: "b", type: "RELATES_TO" },
    { from: "b", to: "a", type: "NEXT_STEP", props: { w: -0.5 } },
    { from: "a", to: "a", type: "RELATES_TO" },
    { from: "topic", to: "source", type: "RELATES_TO" },
  ];
  for (const edge of edges) await store.addEdge({ user: "demo", ...edge });
  const snapshot = await buildSnapshot({ store, user: "demo", now });
  assert.equal(snapshot.links.length, edges.length);
  const key = (link) => JSON.stringify([link.source, link.target, link.type]);
  assert.equal(new Set(snapshot.links.map(key)).size, edges.length);
  for (const edge of edges) {
    assert.deepEqual(snapshot.links.find((link) =>
      link.source === edge.from && link.target === edge.to && link.type === edge.type), {
      source: edge.from, target: edge.to, type: edge.type, w: edge.props?.w ?? 1,
    });
  }
  assert.deepEqual(snapshot.nodes.find((node) => node.id === "a").tags, ["topic"]);
});

test("snapshot truncates Markdown to 8000 Unicode characters without mutating the stored note", async (t) => {
  const { store, memory } = setup(t);
  const text = `${"あ".repeat(7_999)}😀末尾`;
  const { id } = await memory.remember({
    user: "demo", source: "cursor", kind: "fact", title: "long note", text,
  });
  const snapshot = await buildSnapshot({ store, user: "demo", now });
  const node = snapshot.nodes.find((item) => item.id === id);
  assert.equal(Array.from(node.text).length, 8_000);
  assert.equal(node.text, `${"あ".repeat(7_999)}😀`);
  assert.equal((await store.getNode({ user: "demo", id })).props.text, text);
});

test("snapshot isolates users and surfaces store failures rather than returning an empty graph", async (t) => {
  const { store, memory } = setup(t);
  await memory.remember({ user: "other", source: "copilot", kind: "fact", title: "private", text: "private" });
  assert.deepEqual((await buildSnapshot({ store, user: "demo", now })).nodes, []);
  await store.close();
  await assert.rejects(buildSnapshot({ store, user: "demo", now }), /closed/u);
});
