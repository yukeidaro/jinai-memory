import assert from "node:assert/strict";
import test from "node:test";
import { createEmbedder } from "../src/embedder.js";
import { createMemory } from "../src/memory.js";
import { createMemoryStore } from "../src/store/memory-store.js";

function estimateTokens(text) {
  const ascii = (text.match(/[\u0000-\u007f]/g) ?? []).length;
  return ascii / 4 + Array.from(text).length - ascii;
}

test("2,000 remembered notes keep orient <= 400 and both kinds of open <= 800 tokens", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  const fake = createEmbedder({ provider: "fake", dim: 64 });
  let embeddings = 0;
  let notifications = 0;
  const memory = createMemory({
    store,
    embedder: {
      dim: fake.dim,
      async embed(texts) {
        embeddings += texts.length;
        return fake.embed(texts);
      },
    },
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    onTouch({ nodeIds }) {
      notifications += 1;
      assert.ok(nodeIds.length > 0);
    },
  });
  const first = await memory.remember({
    user: "scale", source: "claude", kind: "preference", title: "ハンバーグが好き",
    text: "ハンバーグが好き", tags: ["ハンバーグ", "夕飯"],
  });
  await memory.remember({
    user: "scale", source: "chatgpt", kind: "event", title: "昨日の夕飯",
    text: "夕飯にハンバーグを食べた", tags: ["ハンバーグ", "夕飯"],
    occurredAt: "2026-10-15T12:00:00.000Z",
  });

  async function assertBounded() {
    const map = await memory.orient({ user: "scale" });
    assert.ok(estimateTokens(map) <= 400);
    assert.ok(map.split("\n").length <= 6);
    for (const target of [{ id: first.id }, { title: "ハンバーグ" }, { title: "負荷試験" }]) {
      if (target.title === "負荷試験" && embeddings < 3) continue;
      const opened = await memory.open({ user: "scale", ...target });
      assert.ok(estimateTokens(JSON.stringify(opened)) <= 800);
      assert.ok(opened.neighbors.length <= 5);
    }
  }
  await assertBounded();
  for (let index = 2; index < 2_000; index += 1) {
    await memory.remember({
      user: "scale", source: index % 2 ? "claude" : "chatgpt",
      kind: ["preference", "event", "fact", "decision"][index % 4],
      title: `ダミー記憶 ${index}`,
      text: `記録 ${index}: ${"長い本文と記憶の内容を保存する。\n".repeat(12)}`,
      summary: `ダミー ${index} ${"詳しい一行要約".repeat(20)}`,
      tags: ["負荷試験", `トピック ${index % 30}`],
    });
  }
  assert.equal((await store.listNodes({ user: "scale", label: "Memory" })).length, 2_000);
  assert.equal(embeddings, 2_000);
  await assertBounded();
  assert.equal(embeddings, 2_000);
  assert.equal(notifications, 2_007);
  const topic = await memory.open({ user: "scale", title: "ハンバーグ" });
  assert.equal(topic.neighbors.length, 2);
});

test("open bounds oversized Markdown and summaries without modifying the stored full note", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  const memory = createMemory({
    store,
    embedder: createEmbedder({ provider: "fake", dim: 32 }),
    now: () => new Date("2026-10-16T12:00:00.000Z"),
  });
  const text = `${"# Markdown\n\n".repeat(500)}${"😀長い本文".repeat(500)}`;
  const { id } = await memory.remember({
    user: "large", source: "claude", kind: "fact", title: "long note", text, tags: ["large"],
  });
  for (let index = 0; index < 7; index += 1) {
    await memory.remember({
      user: "large", source: "claude", kind: "fact", title: `related ${index}`,
      text: "long note", summary: "要約".repeat(2_000), tags: ["large"],
      relatesTo: [id],
    });
  }
  const result = await memory.open({ user: "large", id });
  assert.ok(estimateTokens(JSON.stringify(result)) <= 800);
  assert.ok(result.note.text.length < text.length);
  assert.equal((await store.getNode({ user: "large", id })).props.text, text);
  const topic = await memory.open({ user: "large", title: "large" });
  assert.ok(estimateTokens(JSON.stringify(topic)) <= 800);
  assert.equal(topic.neighbors.length, 5);
});

test("map and open stay bounded even when titles, sources, and Topic names are oversized", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  const memory = createMemory({
    store,
    embedder: createEmbedder({ provider: "fake", dim: 16 }),
    now: () => new Date("2026-10-16T12:00:00.000Z"),
  });
  const topic = "非常に長いトピック".repeat(300);
  const { id } = await memory.remember({
    user: "large", source: "長い出典".repeat(300), kind: "event",
    title: "長い題名".repeat(300), text: "本文".repeat(500),
    summary: "要約".repeat(300), tags: [topic],
  });
  assert.ok(estimateTokens(await memory.orient({ user: "large" })) <= 400);
  for (const target of [{ id }, { title: topic }]) {
    assert.ok(estimateTokens(JSON.stringify(await memory.open({ user: "large", ...target }))) <= 800);
  }
});
