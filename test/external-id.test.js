import assert from "node:assert/strict";
import test from "node:test";
import { createMemory } from "../src/memory.js";
import { createMemoryStore } from "../src/store/memory-store.js";

const START = "2026-10-16T12:00:00.000Z";
const LATER = "2026-10-17T12:00:00.000Z";
const NOTE = {
  user: "alice", source: "claude", kind: "fact", title: "positive note", text: "body",
};

function setup(t) {
  const store = createMemoryStore();
  t.after(() => store.close());
  const touches = [];
  const embeds = [];
  let at = START;
  const embedder = {
    dim: 2,
    async embed(texts) {
      embeds.push([...texts]);
      return texts.map((text) => text.startsWith("negative") ? [-1, 0] : [1, 0]);
    },
  };
  const memory = createMemory({
    store, embedder, now: () => new Date(at),
    onTouch: (event) => touches.push(event),
  });
  return { store, memory, embedder, touches, embeds, setTime(value) { at = value; } };
}

async function outgoing(store, id, types, user = "alice") {
  return (await store.neighbors({ user, id, types, limit: 100 }))
    .filter(({ edge }) => edge.from === id);
}

test("externalId deterministically replaces one Memory, including across memory layer instances", async (t) => {
  const { memory, store, embedder, touches } = setup(t);
  const input = { ...NOTE, externalId: "a", tags: ["topic"] };
  const first = await memory.remember(input);
  assert.deepEqual(first, { id: "ext-ca978112ca1bbdcafac231b39a23dc4d", replaced: false });
  const beforeNodes = await store.listNodes({ user: "alice" });
  const beforeEdges = await outgoing(store, first.id);
  assert.deepEqual(await memory.remember(input), { id: first.id, replaced: true });
  const restarted = createMemory({ store, embedder, now: () => new Date(START) });
  assert.deepEqual(await restarted.remember(input), { id: first.id, replaced: true });
  assert.deepEqual(await store.listNodes({ user: "alice" }), beforeNodes);
  assert.deepEqual(await outgoing(store, first.id), beforeEdges);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 1);
  assert.equal((await store.getNode({ user: "alice", id: first.id })).props.externalId, "a");
  assert.equal(touches.length, 2);
  assert.equal(touches[1].op, "remember");
  assert.ok(touches[1].nodeIds.includes(first.id));
});

test("replacement refreshes all content, timestamps, embeddings and the four outgoing edge types", async (t) => {
  const { memory, store, touches, embeds, setTime } = setup(t);
  for (const [id, embedding] of [["positive-peer", [1, 0]], ["negative-peer", [-1, 0]]]) {
    await store.upsertNode({
      user: "alice", id, labels: ["Memory"], props: { title: id, createdAt: START }, embedding,
    });
  }
  const first = await memory.remember({
    ...NOTE, externalId: "cc-session:replace", kind: "event", text: "old body",
    summary: "old summary", occurredAt: "2026-10-15T12:00:00.000Z",
    tags: ["old", "shared"], relatesTo: ["positive-peer"],
  });
  const original = await outgoing(store, first.id);
  assert.deepEqual(original.filter(({ edge }) => edge.type === "SIMILAR").map(({ node }) => node.id),
    ["positive-peer"]);
  setTime(LATER);
  const updated = await memory.remember({
    ...NOTE, externalId: "cc-session:replace", source: "copilot", kind: "decision",
    title: "negative replacement", text: "new body", summary: "new\nsummary",
    tags: ["new"], relatesTo: ["negative-peer"],
  });
  assert.deepEqual(updated, { id: first.id, replaced: true });
  const node = await store.getNode({ user: "alice", id: first.id });
  assert.deepEqual(node.props, {
    title: "negative replacement", text: "new body", summary: "new summary",
    kind: "decision", source: "copilot", createdAt: LATER, occurredAt: null,
    externalId: "cc-session:replace",
  });
  const edges = await outgoing(store, first.id);
  for (const [type, expected] of [
    ["ABOUT", "new"], ["MENTIONED_BY", "copilot"],
    ["SIMILAR", "negative-peer"], ["RELATES_TO", "negative-peer"],
  ]) {
    const selected = edges.filter(({ edge }) => edge.type === type);
    assert.equal(selected.length, 1, type);
    assert.equal(selected[0].node.props.name ?? selected[0].node.id, expected);
  }
  for (const { node: old, edge } of original) {
    const adjacent = await store.neighbors({ user: "alice", id: old.id, types: [edge.type], limit: 100 });
    assert.ok(!adjacent.some(({ node: neighbor }) => neighbor.id === first.id));
  }
  const hit = (await store.vectorSearch({ user: "alice", embedding: [1, 0], k: 10 }))
    .find(({ node: match }) => match.id === first.id);
  assert.equal(hit.score, -1);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 3);
  assert.deepEqual(embeds.at(-1), ["negative replacement\nnew body\nnew"]);
  assert.equal(touches.length, 2);
  assert.equal(touches.at(-1).source, "copilot");
  assert.equal(touches.at(-1).at, LATER);
  assert.equal(new Set(touches.at(-1).nodeIds).size, touches.at(-1).nodeIds.length);
});

test("replacement updates explicit occurredAt, defaults event dates and clears omitted non-event dates", async (t) => {
  const { memory, store, setTime } = setup(t);
  const input = { ...NOTE, externalId: "cc-session:dates", kind: "event" };
  const { id } = await memory.remember({ ...input, occurredAt: START });
  setTime(LATER);
  await memory.remember({ ...input, occurredAt: "2026-10-14T12:00:00.000Z" });
  assert.equal((await store.getNode({ user: "alice", id })).props.occurredAt, "2026-10-14T12:00:00.000Z");
  await memory.remember(input);
  assert.equal((await store.getNode({ user: "alice", id })).props.occurredAt, LATER);
  await memory.remember({ ...input, kind: "fact" });
  assert.equal((await memory.open({ user: "alice", id })).note.occurredAt, null);
});

test("repeated externalId writes keep SIMILAR bounded, unique and free of self edges", async (t) => {
  const { memory, store } = setup(t);
  for (let index = 0; index < 5; index += 1) {
    await store.upsertNode({
      user: "alice", id: `peer-${index}`, labels: ["Memory"],
      props: { title: `peer-${index}`, createdAt: START }, embedding: [1, 0],
    });
  }
  const input = { ...NOTE, externalId: "cc-session:similar", tags: ["topic"] };
  const { id } = await memory.remember(input);
  const before = await outgoing(store, id);
  const count = (await store.listNodes({ user: "alice" })).length;
  for (let index = 0; index < 5; index += 1) {
    await memory.remember(input);
    const similar = await outgoing(store, id, ["SIMILAR"]);
    assert.equal(similar.length, 3);
    assert.equal(new Set(similar.map(({ node }) => node.id)).size, 3);
    assert.ok(similar.every(({ node }) => node.id !== id));
    assert.deepEqual(await outgoing(store, id), before);
    assert.equal((await store.listNodes({ user: "alice" })).length, count);
  }
});

test("follows upserts one predecessor-to-current NEXT_STEP and touches both Memories", async (t) => {
  const { memory, store, touches } = setup(t);
  const previous = await memory.remember({ ...NOTE, externalId: "cc-session:first" });
  const input = { ...NOTE, externalId: "cc-session:second", follows: "cc-session:first" };
  let current;
  for (let index = 0; index < 3; index += 1) {
    current = await memory.remember(input);
    assert.deepEqual(current, { id: current.id, replaced: index > 0, followsLinked: true });
    const edges = await outgoing(store, previous.id, ["NEXT_STEP"]);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0].edge, { from: previous.id, to: current.id, type: "NEXT_STEP", props: {} });
    assert.ok(touches.at(-1).nodeIds.includes(previous.id));
    assert.ok(touches.at(-1).nodeIds.includes(current.id));
  }
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 2);
});

test("missing follows returns false without a placeholder, then links when retried after its predecessor", async (t) => {
  const { memory, store } = setup(t);
  const input = { ...NOTE, externalId: "cc-session:current", follows: "cc-session:missing" };
  const first = await memory.remember(input);
  assert.deepEqual(first, { id: first.id, replaced: false, followsLinked: false });
  assert.deepEqual(await outgoing(store, first.id, ["NEXT_STEP"]), []);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 1);
  const previous = await memory.remember({ ...NOTE, externalId: input.follows });
  assert.deepEqual(await memory.remember(input), { id: first.id, replaced: true, followsLinked: true });
  assert.equal((await outgoing(store, previous.id, ["NEXT_STEP"]))[0].node.id, first.id);
  const legacy = await memory.remember({ ...NOTE, follows: input.follows });
  assert.equal(legacy.replaced, false);
  assert.equal(legacy.followsLinked, true);
  assert.match(legacy.id, /^[0-9a-f-]{36}$/u);
});

test("replacement preserves every incoming edge and outgoing NEXT_STEP even when follows is omitted", async (t) => {
  const { memory, store } = setup(t);
  await memory.remember({ ...NOTE, externalId: "cc-session:previous" });
  const current = await memory.remember({
    ...NOTE, externalId: "cc-session:current", follows: "cc-session:previous", tags: ["old"],
  });
  const next = await memory.remember({
    ...NOTE, externalId: "cc-session:next", follows: "cc-session:current",
  });
  for (const type of ["ABOUT", "MENTIONED_BY", "RELATES_TO"]) {
    await store.addEdge({ user: "alice", from: next.id, to: current.id, type, props: { kept: true } });
  }
  const incoming = (await store.neighbors({ user: "alice", id: current.id, limit: 100 }))
    .filter(({ edge }) => edge.to === current.id);
  const nextStep = await outgoing(store, current.id, ["NEXT_STEP"]);
  const replaced = await memory.remember({
    ...NOTE, externalId: "cc-session:current", title: "negative replacement", tags: ["new"],
  });
  assert.deepEqual(replaced, { id: current.id, replaced: true });
  assert.deepEqual((await store.neighbors({ user: "alice", id: current.id, limit: 100 }))
    .filter(({ edge }) => edge.to === current.id), incoming);
  assert.deepEqual(await outgoing(store, current.id, ["NEXT_STEP"]), nextStep);
  assert.equal((await outgoing(store, current.id, ["ABOUT"]))[0].node.props.name, "new");
});

test("externalId replacement and follows lookup never cross user graphs", async (t) => {
  const { memory, store } = setup(t);
  const input = { ...NOTE, externalId: "cc-session:shared", tags: ["alice-topic"] };
  const alice = await memory.remember(input);
  await memory.remember({ ...NOTE, externalId: "cc-session:alice-only" });
  const bobInput = {
    ...input, user: "bob", title: "bob note", tags: ["bob-topic"], follows: "cc-session:alice-only",
  };
  const bob = await memory.remember(bobInput);
  assert.deepEqual(bob, { id: alice.id, replaced: false, followsLinked: false });
  const bobNodes = await store.listNodes({ user: "bob" });
  const bobEdges = await outgoing(store, bob.id, undefined, "bob");
  assert.equal((await memory.remember({ ...input, title: "negative alice", tags: ["new"] })).replaced, true);
  assert.deepEqual(await store.listNodes({ user: "bob" }), bobNodes);
  assert.deepEqual(await outgoing(store, bob.id, undefined, "bob"), bobEdges);
  const aliceNodes = await store.listNodes({ user: "alice" });
  const aliceEdges = await outgoing(store, alice.id);
  await memory.remember({ ...NOTE, user: "bob", externalId: "cc-session:alice-only" });
  assert.equal((await memory.remember(bobInput)).followsLinked, true);
  assert.deepEqual(await store.listNodes({ user: "alice" }), aliceNodes);
  assert.deepEqual(await outgoing(store, alice.id), aliceEdges);
});

test("external references reject invalid shapes before embedding or graph changes and accept boundaries", async (t) => {
  const { memory, store, touches, embeds } = setup(t);
  for (const key of ["externalId", "follows"]) {
    for (const value of ["", " ", "bad/id", "bad\n", "bad\r\n", "日本語", "a".repeat(201), null, 1, {}, [], true]) {
      await assert.rejects(memory.remember({ ...NOTE, [key]: value }), new RegExp(key, "u"));
    }
  }
  assert.deepEqual(await store.listNodes({ user: "alice" }), []);
  assert.deepEqual(touches, []);
  assert.deepEqual(embeds, []);
  const ids = [];
  for (const externalId of ["a", "A", "A0:_.-", "x".repeat(200)]) {
    const saved = await memory.remember({ ...NOTE, externalId, follows: "y".repeat(200) });
    assert.equal(saved.replaced, false);
    assert.equal(saved.followsLinked, false);
    ids.push(saved.id);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("omitting externalId still creates independent UUID Memories with the original props", async (t) => {
  const { memory, store } = setup(t);
  t.mock.method(store, "removeEdges", async () => { throw new Error("Unexpected edge removal"); });
  const first = await memory.remember(NOTE);
  const second = await memory.remember(NOTE);
  assert.deepEqual(first, { id: first.id, replaced: false });
  assert.deepEqual(second, { id: second.id, replaced: false });
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^[0-9a-f-]{36}$/u);
  assert.match(second.id, /^[0-9a-f-]{36}$/u);
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 2);
  assert.deepEqual((await store.getNode({ user: "alice", id: first.id })).props, {
    title: NOTE.title, text: NOTE.text, summary: NOTE.text, kind: NOTE.kind,
    source: NOTE.source, createdAt: START,
  });
});

test("concurrent imports with one externalId serialize into one Memory and one NEXT_STEP", async (t) => {
  const { memory, store } = setup(t);
  const previous = await memory.remember({ ...NOTE, externalId: "cc-session:previous" });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => memory.remember({
    ...NOTE, externalId: "cc-session:concurrent", follows: "cc-session:previous",
    text: `version ${index}`, tags: ["shared"],
  })));
  assert.equal(new Set(results.map(({ id }) => id)).size, 1);
  assert.deepEqual(results.map(({ replaced }) => replaced), [false, ...Array(7).fill(true)]);
  assert.ok(results.every(({ followsLinked }) => followsLinked));
  assert.equal((await store.listNodes({ user: "alice", label: "Memory" })).length, 2);
  assert.equal((await store.listNodes({ user: "alice", label: "Topic" })).length, 1);
  assert.equal((await store.listNodes({ user: "alice", label: "Source" })).length, 1);
  assert.equal((await outgoing(store, previous.id, ["NEXT_STEP"])).length, 1);
  assert.equal((await store.getNode({ user: "alice", id: results[0].id })).props.text, "version 7");
});

test("failed reference resolution or embedding leaves an existing external Memory and its edges intact", async (t) => {
  const { memory, store, embedder, touches } = setup(t);
  const input = { ...NOTE, externalId: "cc-session:failure", tags: ["old"] };
  const { id } = await memory.remember(input);
  const beforeNode = await store.getNode({ user: "alice", id });
  const beforeEdges = await outgoing(store, id);
  await assert.rejects(memory.remember({ ...input, relatesTo: ["missing"] }), /not found/u);
  const mocked = t.mock.method(embedder, "embed", async () => { throw new Error("Embedding failed"); });
  await assert.rejects(memory.remember({ ...input, tags: ["new"] }), /Embedding failed/u);
  assert.deepEqual(await store.getNode({ user: "alice", id }), beforeNode);
  assert.deepEqual(await outgoing(store, id), beforeEdges);
  assert.equal(touches.length, 1);
  mocked.mock.restore();
  assert.equal((await memory.remember({ ...input, tags: ["new"] })).replaced, true);
});
