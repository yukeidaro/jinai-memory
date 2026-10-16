import assert from "node:assert/strict";
import test from "node:test";
import { createEmbedder } from "../src/embedder.js";

function cosine(a, b) {
  const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  return dot / Math.hypot(...a) / Math.hypot(...b);
}

test("fake embeddings are deterministic, finite, dimensioned, and batch ordered", async () => {
  const first = createEmbedder({ provider: "fake", dim: 128 });
  const second = createEmbedder({ provider: "fake", dim: 128 });
  const texts = ["ハンバーグが好き", "a different memory", "ハンバーグが好き"];
  const vectors = await first.embed(texts);
  assert.equal(first.dim, 128);
  assert.equal(vectors.length, texts.length);
  for (const vector of vectors) {
    assert.equal(vector.length, 128);
    assert.ok(vector.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-12);
  }
  assert.deepEqual(vectors[0], vectors[2]);
  assert.deepEqual(vectors, await second.embed(texts));
  assert.notDeepEqual(vectors[0], vectors[1]);
});

test("fake embeddings put shared English words closer than unrelated sentences", async () => {
  const embedder = createEmbedder({ provider: "fake", dim: 512 });
  const [query, related, unrelated] = await embedder.embed([
    "hamburger dinner",
    "I like a hamburger for dinner",
    "quantum physics and orbital mechanics",
  ]);
  assert.ok(cosine(query, related) > 0.3);
  assert.ok(cosine(query, related) > cosine(query, unrelated));
});

test("fake character n-grams share Japanese terms without whitespace", async () => {
  const embedder = createEmbedder({ provider: "fake", dim: 512 });
  const [query, related, unrelated] = await embedder.embed([
    "ハンバーグ",
    "昨日の夕飯にハンバーグを食べた",
    "宇宙探査機の軌道を計算する",
  ]);
  assert.ok(cosine(query, related) > cosine(query, unrelated));
});

test("fake embeddings normalize case and Unicode compatibility forms", async () => {
  const embedder = createEmbedder({ provider: "fake", dim: 64 });
  const vectors = await embedder.embed(["Dinner", "DINNER", "Ｄｉｎｎｅｒ"]);
  assert.deepEqual(vectors[0], vectors[1]);
  assert.deepEqual(vectors[0], vectors[2]);
});

test("fake empty batches and empty texts have deterministic safe results", async () => {
  const embedder = createEmbedder({ provider: "fake", dim: 8 });
  assert.deepEqual(await embedder.embed([]), []);
  assert.deepEqual(await embedder.embed(["", " \n!?"]), [Array(8).fill(0), Array(8).fill(0)]);
});

test("fake vectors returned to the caller do not share mutable state", async () => {
  const embedder = createEmbedder({ provider: "fake", dim: 32 });
  const [expected] = await embedder.embed(["dinner"]);
  const batch = await embedder.embed(["dinner", "dinner"]);
  batch[0][0] = 123;
  assert.deepEqual(batch[1], expected);
  assert.deepEqual((await embedder.embed(["dinner"]))[0], expected);
});

test("embedder configuration rejects invalid dimensions and providers", () => {
  for (const dim of [undefined, 0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createEmbedder({ provider: "fake", dim }), /dim/);
  }
  assert.throws(() => createEmbedder({ provider: "other", dim: 8 }), /provider/);
  assert.throws(() => createEmbedder({ provider: "fake", dim: 8, model: "" }), /model/);
});

test("fake embed rejects non-string inputs explicitly", async () => {
  const embedder = createEmbedder({ provider: "fake", dim: 8 });
  for (const input of [null, "not an array", [42], [undefined]]) {
    await assert.rejects(embedder.embed(input), /array of strings/);
  }
});
