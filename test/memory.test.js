import assert from "node:assert/strict";
import test from "node:test";
import { createEmbedder } from "../src/embedder.js";
import { createMemory } from "../src/memory.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const DAY = 86_400_000;
const START = "2026-10-16T12:00:00.000Z";
const TAGS = ["ハンバーグ", "夕飯", "食事"];

function estimateTokens(text) {
  const ascii = (text.match(/[\u0000-\u007f]/g) ?? []).length;
  return ascii / 4 + Array.from(text).length - ascii;
}

function setup(t, customEmbedder) {
  const store = createMemoryStore();
  t.after(() => store.close());
  const touches = [];
  const embeds = [];
  let clock = new Date(START);
  const base = customEmbedder ?? createEmbedder({ provider: "fake", dim: 128 });
  const embedder = {
    dim: base.dim,
    async embed(texts) {
      embeds.push([...texts]);
      return base.embed(texts);
    },
  };
  const memory = createMemory({
    store,
    embedder,
    now: () => new Date(clock),
    onTouch: async (event) => { touches.push(event); },
  });
  return {
    store, memory, touches, embeds,
    advanceDays(days) { clock = new Date(clock.getTime() + days * DAY); },
  };
}

async function mealMemories(memory, user = "alice") {
  const preference = await memory.remember({
    user, source: "claude", kind: "preference",
    title: "ハンバーグが好き", text: "ハンバーグが好き", tags: TAGS,
  });
  const event = await memory.remember({
    user, source: "chatgpt", kind: "event",
    title: "昨日の夕飯", text: "夕飯にハンバーグを食べた",
    occurredAt: "2026-10-15T12:00:00.000Z", tags: TAGS,
  });
  return { preference, event };
}

test("recall returns both a preference and yesterday's dinner without excluding either", async (t) => {
  const { memory } = setup(t);
  const { preference, event } = await mealMemories(memory);
  const result = await memory.recall({ user: "alice", query: "今日の夕飯、何がいい？", source: "copilot" });
  assert.equal(result.preferences.find((item) => item.id === preference.id)?.text, "ハンバーグが好き");
  const yesterday = result.recent_events.find((item) => item.id === event.id);
  assert.equal(yesterday?.days_ago, 1);
  assert.equal(yesterday.source, "chatgpt");
  assert.match(result.hint, /提案する前に確認/);
  for (const item of [...result.preferences, ...result.recent_events]) {
    assert.equal(typeof item.score, "number");
    assert.equal(typeof item.summary, "string");
  }
});

test("advancing now by eight days moves yesterday's event to others and removes the hint", async (t) => {
  const { memory, advanceDays } = setup(t);
  const { event, preference } = await mealMemories(memory);
  advanceDays(8);
  const result = await memory.recall({ user: "alice", query: "今日の夕飯、何がいい？" });
  assert.deepEqual(result.recent_events, []);
  assert.equal(result.others.find((item) => item.id === event.id)?.days_ago, 9);
  assert.ok(result.preferences.some((item) => item.id === preference.id));
  assert.equal(result.hint, null);
});

test("orient is a rules-only map with relative dates and no more than 400 tokens", async (t) => {
  const { memory, embeds, advanceDays } = setup(t);
  await mealMemories(memory);
  const calls = embeds.length;
  const result = await memory.orient({ user: "alice" });
  assert.match(result.split("\n")[0], /open\(title\)/);
  assert.match(result, /ハンバーグ/);
  assert.match(result, /昨日/);
  assert.match(result, /好み/);
  assert.ok(estimateTokens(result) <= 400);
  assert.ok(result.split("\n").length <= 6);
  advanceDays(2);
  assert.match(await memory.orient({ user: "alice" }), /3日前/);
  assert.equal(embeds.length, calls);
});

test("open resolves Topic names and Memory ids or titles with the required shapes", async (t) => {
  const { memory, embeds } = setup(t);
  const { preference, event } = await mealMemories(memory);
  const calls = embeds.length;
  const topic = await memory.open({ user: "alice", title: "ハンバーグ" });
  assert.equal(topic.note.kind, "topic");
  assert.equal(topic.note.title, "ハンバーグ");
  assert.deepEqual(new Set(topic.neighbors.map((item) => item.id)), new Set([preference.id, event.id]));
  const byId = await memory.open({ user: "alice", id: event.id });
  const byTitle = await memory.open({ user: "alice", title: "昨日の夕飯" });
  assert.deepEqual(byId, byTitle);
  assert.deepEqual(Object.keys(byId.note).sort(), [
    "id", "title", "kind", "text", "source", "createdAt", "occurredAt", "days_ago",
  ].sort());
  assert.equal(byId.note.days_ago, 1);
  assert.equal(byId.note.text, "夕飯にハンバーグを食べた");
  for (const neighbor of byId.neighbors) {
    assert.deepEqual(Object.keys(neighbor).sort(), ["id", "title", "summary", "kind", "source", "w"].sort());
  }
  assert.ok(estimateTokens(JSON.stringify(byId)) <= 800);
  assert.equal(embeds.length, calls);
});

test("remember persists the node, one-line summary, unique Topics, and unique Source", async (t) => {
  const { memory, store, embeds } = setup(t);
  const text = `本文\n${"😀".repeat(100)}`;
  const first = await memory.remember({
    user: "alice", source: "claude", kind: "event", title: "event",
    text, tags: ["夕飯", "夕飯", " 食事 "],
  });
  await memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "fact",
    text: "A fact", tags: ["夕飯", "食事"], summary: "one\nline",
  });
  const node = await store.getNode({ user: "alice", id: first.id });
  assert.deepEqual(node.labels, ["Memory"]);
  assert.equal(node.props.createdAt, START);
  assert.equal(node.props.occurredAt, START);
  assert.equal(node.props.summary, Array.from(text).slice(0, 80).join("").replace(/\s+/gu, " ").trim());
  assert.equal(node.props.text, text);
  assert.equal("embedding" in node.props, false);
  assert.equal((await store.listNodes({ user: "alice", label: "Topic" })).length, 2);
  assert.equal((await store.listNodes({ user: "alice", label: "Source" })).length, 1);
  const edges = await store.neighbors({ user: "alice", id: first.id, types: ["ABOUT"], limit: 10 });
  assert.equal(edges.length, 2);
  assert.ok(edges.every(({ edge }) => edge.props.w === 1 && edge.from === first.id));
  assert.equal(embeds.length, 2);
  assert.deepEqual(embeds[0], [[ "event", text, "夕飯 食事" ].join("\n")]);
  const [fact] = await store.findNodes({ user: "alice", label: "Memory", where: { title: "fact" } });
  assert.equal(fact.props.summary, "one line");
  assert.equal("occurredAt" in fact.props, false);
});

test("SIMILAR selects at most three existing notes and uses cosine plus fractional-day recency", async (t) => {
  const { memory, store, embeds } = setup(t, {
    dim: 2, async embed(texts) { return texts.map(() => [1, 0]); },
  });
  for (let index = 0; index < 6; index += 1) {
    await memory.remember({
      user: "alice", source: "claude", kind: "event",
      title: `old ${index}`, text: "same",
      occurredAt: index === 0 ? "2026-10-01T00:00:00.000Z" : START,
    });
  }
  const last = await memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "new", text: "same",
  });
  const edges = await store.neighbors({
    user: "alice", id: last.id, types: ["SIMILAR"], limit: 100,
  });
  assert.equal(edges.length, 3);
  assert.ok(edges.every(({ node, edge }) => node.id !== last.id && edge.from === last.id));
  for (const { node, edge } of edges) {
    const days = (Date.parse(START) - Date.parse(node.props.occurredAt)) / DAY;
    assert.ok(Math.abs(edge.props.w - (0.7 + 0.3 * Math.exp(-days / 30))) < 1e-12);
  }
  assert.equal(embeds.length, 7);
});

test("SIMILAR ignores cosine scores below 0.3, including opposite vectors", async (t) => {
  const { memory, store } = setup(t, {
    dim: 2,
    async embed(texts) { return texts.map((text) => text.startsWith("positive") ? [1, 0] : [-1, 0]); },
  });
  await memory.remember({ user: "alice", source: "claude", kind: "fact", title: "negative", text: "" });
  const { id } = await memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "positive", text: "",
  });
  assert.deepEqual(await store.neighbors({ user: "alice", id, types: ["SIMILAR"], limit: 10 }), []);
});

test("SIMILAR includes the 0.3 boundary and selects by similarity rather than recency", async (t) => {
  const { memory, store } = setup(t, {
    dim: 2, async embed(texts) { return texts.map(() => [1, 0]); },
  });
  for (const [index, score] of [0.95, 0.8, 0.3, 0.299, 0, -1].entries()) {
    await store.upsertNode({
      user: "alice", id: `existing-${index}`, labels: ["Memory"],
      props: {
        title: `existing-${index}`, kind: "fact", text: "", source: "claude",
        createdAt: index === 0 ? "2026-01-01T00:00:00.000Z" : START,
      },
      embedding: [score, Math.sqrt(1 - score * score)],
    });
  }
  const { id } = await memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "new", text: "",
  });
  const edges = await store.neighbors({ user: "alice", id, types: ["SIMILAR"], limit: 10 });
  assert.deepEqual(new Set(edges.map(({ node }) => node.id)), new Set(["existing-0", "existing-1", "existing-2"]));
  assert.ok(edges.find(({ node }) => node.id === "existing-2"));
});

test("RELATES_TO resolves both ids and titles, and bad references do not create a note", async (t) => {
  const { memory, store, embeds } = setup(t);
  const first = await memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "first", text: "one",
  });
  const second = await memory.remember({
    user: "alice", source: "claude", kind: "decision", title: "second", text: "two",
    relatesTo: [first.id, "first"],
  });
  const edges = await store.neighbors({
    user: "alice", id: second.id, types: ["RELATES_TO"], limit: 10,
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].node.id, first.id);
  await assert.rejects(memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "missing target", text: "",
    relatesTo: ["not present"],
  }), /not found/);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 2);
  assert.equal(embeds.length, 2);
});

test("concurrent remember calls share Topic and Source nodes, and failed writes do not poison the queue", async (t) => {
  const { memory, store } = setup(t);
  const invalid = memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "bad", text: "",
    relatesTo: ["missing"],
  });
  const valid = Array.from({ length: 12 }, (_, index) => memory.remember({
    user: "alice", source: "claude", kind: "fact", title: `note ${index}`,
    text: "shared", tags: ["shared"],
  }));
  await assert.rejects(invalid, /not found/);
  await Promise.all(valid);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 12);
  assert.equal((await store.listNodes({ user: "alice", label: "Topic" })).length, 1);
  assert.equal((await store.listNodes({ user: "alice", label: "Source" })).length, 1);
});

test("open Memory returns the strongest five distinct neighbors in both directions", async (t) => {
  const { memory, store } = setup(t);
  const { id } = await memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "root", text: "root body",
  });
  for (let index = 0; index < 7; index += 1) {
    const other = `other-${index}`;
    await store.upsertNode({
      user: "alice", id: other, labels: ["Memory"],
      props: { title: other, text: other, summary: "one\nline", kind: "fact", source: "cursor", createdAt: START },
    });
    await store.addEdge({
      user: "alice", from: index % 2 ? id : other, to: index % 2 ? other : id,
      type: "SIMILAR", props: { w: index + 1 },
    });
  }
  await store.addEdge({ user: "alice", from: id, to: "other-6", type: "RELATES_TO", props: { w: 9 } });
  const result = await memory.open({ user: "alice", id });
  assert.deepEqual(result.neighbors.map((item) => item.w), [9, 6, 5, 4, 3]);
  assert.equal(new Set(result.neighbors.map((item) => item.id)).size, 5);
  assert.ok(result.neighbors.every((item) => item.summary === "one line"));
});

test("open Topic picks the newest five rather than the first five inserted", async (t) => {
  const { memory } = setup(t);
  for (let index = 0; index < 8; index += 1) {
    await memory.remember({
      user: "alice", source: "claude", kind: "event", title: `event ${index}`,
      text: "topic event", tags: ["topic"],
      occurredAt: new Date(Date.parse(START) - (7 - index) * DAY).toISOString(),
    });
  }
  const result = await memory.open({ user: "alice", title: "topic" });
  assert.deepEqual(result.neighbors.map((item) => item.title), ["event 7", "event 6", "event 5", "event 4", "event 3"]);
});

test("recall expands vector hits through shared Topics to notes outside the vector results", async (t) => {
  const { memory, store } = setup(t);
  const { preference, event } = await mealMemories(memory);
  const hit = await store.getNode({ user: "alice", id: event.id });
  const calls = [];
  store.vectorSearch = async (args) => {
    calls.push(args);
    return [{ node: hit, score: 0.6 }];
  };
  const result = await memory.recall({ user: "alice", query: "今は何がおすすめ？" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].k, 10);
  assert.deepEqual(calls[0].labels, ["Memory"]);
  assert.ok(result.preferences.some((item) => item.id === preference.id && item.score === 0.6));
  assert.ok(result.recent_events.some((item) => item.id === event.id));
});

test("recall also finds Topics named inside a question when vector search has no hits", async (t) => {
  const { memory, store } = setup(t);
  const { preference, event } = await mealMemories(memory);
  store.vectorSearch = async () => [];
  const result = await memory.recall({ user: "alice", query: "今夜のハンバーグはどう？" });
  assert.deepEqual(result.preferences.map((item) => item.id), [preference.id]);
  assert.deepEqual(result.recent_events.map((item) => item.id), [event.id]);
  assert.equal(result.preferences[0].score, 1);
});

test("recall categorizes facts, decisions, and old events, sorts recent events, and honors limit", async (t) => {
  const { memory } = setup(t);
  for (const [kind, days, title] of [
    ["event", 7, "seven"], ["event", 1, "yesterday"], ["event", 0, "today"],
    ["event", 8, "old"], ["fact", 0, "fact"], ["decision", 0, "decision"],
  ]) {
    await memory.remember({
      user: "alice", source: "claude", kind, title, text: title, tags: ["shared"],
      occurredAt: new Date(Date.parse(START) - days * DAY).toISOString(),
    });
  }
  const result = await memory.recall({ user: "alice", query: "shared" });
  assert.deepEqual(result.recent_events.map((item) => item.days_ago), [0, 1, 7]);
  assert.deepEqual(new Set(result.others.map((item) => item.title)), new Set(["old", "fact", "decision"]));
  assert.ok(result.others.every((item) => Number.isInteger(item.days_ago)));
  const limited = await memory.recall({ user: "alice", query: "shared", limit: 2 });
  assert.equal(limited.preferences.length + limited.recent_events.length + limited.others.length, 2);
});

test("every successful populated operation fires onTouch with unique nonempty nodeIds and caller source", async (t) => {
  const { memory, touches } = setup(t);
  const { preference } = await mealMemories(memory);
  await memory.open({ user: "alice", id: preference.id, source: "cursor" });
  await memory.recall({ user: "alice", query: "夕飯", source: "copilot" });
  await memory.orient({ user: "alice" });
  assert.deepEqual(touches.map((item) => item.op), ["remember", "remember", "open", "recall", "orient"]);
  assert.deepEqual(touches.map((item) => item.source), ["claude", "chatgpt", "cursor", "copilot", undefined]);
  for (const item of touches) {
    assert.equal(item.user, "alice");
    assert.equal(item.at, START);
    assert.ok(item.nodeIds.length > 0);
    assert.equal(new Set(item.nodeIds).size, item.nodeIds.length);
    assert.ok(item.nodeIds.every((id) => typeof id === "string"));
  }
  assert.ok(touches[0].nodeIds.includes(preference.id));
});

test("one user's memories, Topics, Sources, and ids are inaccessible to another user", async (t) => {
  const { memory, store } = setup(t);
  const { preference, event } = await mealMemories(memory);
  const bob = await memory.remember({
    user: "bob", source: "claude", kind: "preference", title: "寿司が好き", text: "寿司が好き", tags: ["寿司"],
  });
  const result = await memory.recall({ user: "bob", query: "ハンバーグと夕飯" });
  const ids = [...result.preferences, ...result.recent_events, ...result.others].map((item) => item.id);
  assert.ok(ids.includes(bob.id));
  assert.ok(!ids.includes(preference.id) && !ids.includes(event.id));
  assert.equal(await store.getNode({ user: "bob", id: preference.id }), null);
  await assert.rejects(memory.open({ user: "bob", id: preference.id }), /not found/);
  await assert.rejects(memory.open({ user: "bob", title: "ハンバーグ" }), /not found/);
  assert.doesNotMatch(await memory.orient({ user: "bob" }), /ハンバーグ|夕飯/);
  assert.equal((await store.findNodes({ user: "bob", label: "Topic", where: { name: "夕飯" } })).length, 0);
});

test("empty graph operations notify truthfully without creating placeholder nodes", async (t) => {
  const { memory, touches, store } = setup(t);
  assert.match(await memory.orient({ user: "new" }), /まだありません/);
  const result = await memory.recall({ user: "new", query: "夕飯" });
  assert.deepEqual(result, { preferences: [], recent_events: [], others: [], hint: null });
  assert.deepEqual(touches.map((item) => item.nodeIds), [[], []]);
  assert.deepEqual(await store.listNodes({ user: "new" }), []);
  await assert.rejects(memory.open({ user: "new", title: "missing" }), /not found/);
});

test("untagged existing notes still produce a meaningful orient touch", async (t) => {
  const { memory, touches } = setup(t);
  const { id } = await memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "untagged", text: "body",
  });
  await memory.orient({ user: "alice" });
  assert.deepEqual(touches.at(-1).nodeIds, [id]);
});

test("orient ranks Topics by recent events, preferences, facts, and recency, capped at five", async (t) => {
  const { memory } = setup(t);
  const specifications = [
    ["recent", "event", 0], ["recent", "event", 0],
    ["preferences", "preference", 0], ["preferences", "preference", 0],
    ["fact", "fact", 0], ["decision", "decision", 0],
    ["old-event", "event", 8], ["old-decision", "decision", 20],
  ];
  for (const [index, [topic, kind, days]] of specifications.entries()) {
    await memory.remember({
      user: "alice", source: "claude", kind, title: `note ${index}`, text: "short",
      tags: [topic], occurredAt: new Date(Date.parse(START) - days * DAY).toISOString(),
    });
  }
  const lines = (await memory.orient({ user: "alice" })).split("\n").slice(1);
  assert.deepEqual(lines.map((line) => line.split(" — ")[0]), [
    "recent", "preferences", "fact", "decision", "old-event",
  ]);
  assert.ok(lines[0].includes("今日"));
});

test("invalid input and invalid embedder output reject explicitly without writing notes", async (t) => {
  const { memory, store } = setup(t);
  const valid = { user: "alice", source: "claude", kind: "fact", title: "test", text: "body" };
  for (const change of [
    { user: "" }, { source: "" }, { title: "" }, { text: null }, { kind: "unknown" },
    { tags: [42] }, { relatesTo: [""] }, { summary: null }, { occurredAt: "not a date" },
  ]) {
    await assert.rejects(memory.remember({ ...valid, ...change }));
  }
  await assert.rejects(memory.recall({ user: "alice", query: "" }), /query/);
  await assert.rejects(memory.recall({ user: "alice", query: "test", limit: 0 }), /limit/);
  assert.deepEqual(await store.listNodes({ user: "alice" }), []);
  const broken = createMemory({
    store, embedder: { dim: 2, async embed() { return [[NaN, 0]]; } },
  });
  await assert.rejects(broken.remember(valid), /invalid vector/);
  assert.deepEqual(await store.listNodes({ user: "alice" }), []);
});

test("onTouch failures are surfaced rather than silently swallowed", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  const memory = createMemory({
    store, embedder: createEmbedder({ provider: "fake", dim: 16 }),
    onTouch() { throw new Error("notification failed"); },
  });
  await assert.rejects(memory.remember({
    user: "alice", source: "claude", kind: "fact", title: "saved", text: "body",
  }), /notification failed/);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 1);
});

test("store upserts merge node props and labels and never expose or alias embeddings", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  await store.ensureIndexes({ user: "a", dim: 2 });
  const props = { title: "old", createdAt: START };
  const embedding = [1, 0];
  const node = await store.upsertNode({ user: "a", id: "id", labels: ["Memory"], props, embedding });
  props.title = "changed outside";
  embedding[0] = 0;
  node.props.title = "changed return";
  node.labels.push("changed");
  const updated = await store.upsertNode({
    user: "a", id: "id", labels: ["Memory", "Extra"], props: { title: "new" },
  });
  assert.deepEqual(updated, { id: "id", labels: ["Memory", "Extra"], props: { title: "new", createdAt: START } });
  const hit = (await store.vectorSearch({ user: "a", embedding: [1, 0], k: 1 }))[0];
  assert.equal(hit.score, 1);
  assert.equal("embedding" in hit.node, false);
  assert.equal("embedding" in hit.node.props, false);
  hit.node.props.title = "changed search";
  assert.equal((await store.getNode({ user: "a", id: "id" })).props.title, "new");
});

test("store exact matching, label filtering, since filtering, ordering, and limits", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  for (const [id, label, day] of [["old", "Memory", 1], ["new", "Memory", 3], ["topic", "Topic", 2]]) {
    await store.upsertNode({
      user: "a", id, labels: [label],
      props: { name: "same", createdAt: `2026-10-0${day}T00:00:00.000Z` },
    });
  }
  assert.deepEqual((await store.listNodes({ user: "a" })).map((node) => node.id), ["new", "topic", "old"]);
  assert.deepEqual((await store.listNodes({
    user: "a", label: "Memory", sinceIso: "2026-10-02T00:00:00.000Z", limit: 1,
  })).map((node) => node.id), ["new"]);
  assert.equal((await store.findNodes({ user: "a", label: "Memory", where: { name: "same" }, limit: 1 })).length, 1);
  assert.deepEqual(await store.findNodes({ user: "a", where: { name: "sam" } }), []);
  assert.deepEqual(await store.listNodes({ user: "a", limit: 0 }), []);
  assert.deepEqual(await store.findNodes({ user: "new user" }), []);
  assert.equal(await store.getNode({ user: "a", id: "missing" }), null);
});

test("store edges upsert, preserve direction, sort missing weights as zero, and follow both directions", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  for (const id of ["one", "two", "three"]) {
    await store.upsertNode({ user: "a", id, labels: ["Memory"], props: {} });
  }
  await store.addEdge({ user: "a", from: "one", to: "two", type: "RELATES_TO", props: { w: 0.1, kept: true } });
  const edge = await store.addEdge({ user: "a", from: "one", to: "two", type: "RELATES_TO", props: { w: 0.8 } });
  edge.props.w = 100;
  await store.addEdge({ user: "a", from: "three", to: "two", type: "SIMILAR" });
  const incoming = await store.neighbors({ user: "a", id: "two", limit: 10 });
  assert.equal(incoming.length, 2);
  assert.deepEqual(incoming.map(({ node }) => node.id), ["one", "three"]);
  assert.deepEqual(incoming[0].edge, {
    from: "one", to: "two", type: "RELATES_TO", props: { w: 0.8, kept: true },
  });
  assert.equal((await store.neighbors({ user: "a", id: "one", limit: 10 }))[0].node.id, "two");
  assert.equal((await store.neighbors({ user: "a", id: "two", types: ["SIMILAR"], limit: 10 })).length, 1);
  assert.deepEqual(await store.neighbors({ user: "a", id: "two", types: [], limit: 10 }), []);
});

test("store cosine search handles negative and zero vectors, label filters, and nodes without vectors", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  await store.ensureIndexes({ user: "a", dim: 2 });
  for (const [id, embedding, label = "Memory"] of [
    ["same", [2, 0]], ["orthogonal", [0, 1]], ["opposite", [-1, 0]],
    ["zero", [0, 0]], ["topic", [1, 0], "Topic"], ["no-vector", undefined],
  ]) {
    await store.upsertNode({ user: "a", id, labels: [label], props: {}, embedding });
  }
  const result = await store.vectorSearch({ user: "a", embedding: [1, 0], labels: ["Memory"], k: 10 });
  assert.deepEqual(result.map(({ node, score }) => [node.id, score]), [
    ["same", 1], ["orthogonal", 0], ["zero", 0], ["opposite", -1],
  ]);
  const zeros = await store.vectorSearch({ user: "a", embedding: [0, 0], k: 10 });
  assert.ok(zeros.every(({ score }) => score === 0));
  assert.equal((await store.vectorSearch({ user: "a", embedding: [1, 0], k: 1 }))[0].score, 1);
  assert.deepEqual(await store.vectorSearch({ user: "a", embedding: [1, 0], k: 0 }), []);
});

test("store cosine remains finite for very large and very small finite vectors", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  await store.ensureIndexes({ user: "a", dim: 2 });
  for (const [id, magnitude] of [["large", 1e300], ["small", 1e-300]]) {
    await store.upsertNode({
      user: "a", id, labels: ["Memory"], props: {}, embedding: [magnitude, magnitude],
    });
  }
  for (const magnitude of [1e300, 1e-300]) {
    const results = await store.vectorSearch({ user: "a", embedding: [magnitude, magnitude], k: 2 });
    assert.equal(results.length, 2);
    assert.ok(results.every(({ score }) => Number.isFinite(score) && Math.abs(score - 1) < 1e-12));
  }
});

test("store isolates even identical node ids, vector indexes, and edge endpoints by user", async (t) => {
  const store = createMemoryStore();
  t.after(() => store.close());
  await store.ensureIndexes({ user: "a", dim: 2 });
  await store.ensureIndexes({ user: "b", dim: 3 });
  await store.upsertNode({ user: "a", id: "same-id", labels: ["Memory"], props: { title: "A" }, embedding: [1, 0] });
  await store.upsertNode({ user: "b", id: "same-id", labels: ["Memory"], props: { title: "B" }, embedding: [1, 0, 0] });
  await store.upsertNode({ user: "a", id: "a-only", labels: ["Memory"], props: {} });
  assert.equal((await store.getNode({ user: "b", id: "same-id" })).props.title, "B");
  assert.equal((await store.vectorSearch({ user: "b", embedding: [1, 0, 0], k: 10 })).length, 1);
  await assert.rejects(store.addEdge({
    user: "b", from: "same-id", to: "a-only", type: "RELATES_TO",
  }), /endpoints/);
  assert.deepEqual(await store.neighbors({ user: "b", id: "same-id", limit: 10 }), []);
});

test("store rejects invalid dimensions, props, vectors, limits, and use after close", async () => {
  const store = createMemoryStore();
  await store.ensureIndexes({ user: "a", dim: 2 });
  await assert.rejects(store.ensureIndexes({ user: "a", dim: 3 }), /dimension/);
  await assert.rejects(store.ensureIndexes({ user: "b", dim: 0 }), /dim/);
  const node = { user: "a", id: "id", labels: ["Memory"], props: {} };
  await assert.rejects(store.upsertNode({ ...node, embedding: [1] }), /embedding/);
  await assert.rejects(store.upsertNode({ ...node, embedding: [NaN, 0] }), /embedding/);
  await assert.rejects(store.upsertNode({ ...node, props: { embedding: "hidden" } }), /separately/);
  await assert.rejects(store.upsertNode({ ...node, props: { nested: {} } }), /JSON-safe/);
  await assert.rejects(store.vectorSearch({ user: "a", embedding: [1, 0, 0], k: 1 }), /embedding/);
  await assert.rejects(store.listNodes({ user: "a", sinceIso: "bad" }), /ISO/);
  await assert.rejects(store.findNodes({ user: "a", limit: -1 }), /limit/);
  await store.close();
  await store.close();
  await assert.rejects(store.getNode({ user: "a", id: "id" }), /closed/);
});
