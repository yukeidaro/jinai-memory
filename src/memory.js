import { createHash, randomUUID } from "node:crypto";
import { isExcludedImportTopic } from "./importer.js";

const DAY = 86_400_000;
const ALL = Number.MAX_SAFE_INTEGER;
const KINDS = new Set(["preference", "event", "fact", "decision"]);
const KIND_IMPORTANCE = { preference: 3, decision: 2, fact: 1, event: 0 };
const REPLACED_EDGE_TYPES = ["ABOUT", "MENTIONED_BY", "SIMILAR", "RELATES_TO"];
const GUIDE = "詳しくは open(title) で開く。";
// Common classification tags should not crowd out specific topics or alter small demo maps.
const BROAD_TOPIC_RATIO = 0.25;
const BROAD_TOPIC_MIN_MEMORIES = 8;

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
}

function externalReference(value, name) {
  if (value !== undefined && (
    typeof value !== "string" || !/^[A-Za-z0-9:_.-]{1,200}$/u.test(value)
  )) {
    throw new TypeError(`${name} must contain 1-200 letters, digits, colons, underscores, dots or hyphens`);
  }
}

function externalMemoryId(externalId) {
  return `ext-${createHash("sha256").update(externalId).digest("hex").slice(0, 32)}`;
}

function stringArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of strings`);
  for (const item of value) requiredString(item, name);
  return [...new Set(value.map((item) => item.trim()))];
}

function isoDate(value) {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new TypeError("Expected a Date or ISO date string");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid date");
  return date.toISOString();
}

function dateOf(node) {
  return Date.parse(node.props.occurredAt ?? node.props.createdAt);
}

function age(node, at) {
  return Math.max(0, (Date.parse(at) - dateOf(node)) / DAY);
}

function daysAgo(node, at) {
  return Math.floor(age(node, at));
}

function oneLine(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function summaryOf(node) {
  return oneLine(node.props.summary ?? Array.from(node.props.text ?? "").slice(0, 80).join(""));
}

function orientSummaryOf(node) {
  return summaryOf(node) || oneLine(node.props.title ?? "");
}

function titleOf(node) {
  return node.props.title ?? node.props.name;
}

function kindOf(node) {
  return node.props.kind ?? (node.labels.includes("Topic") ? "topic" : "source");
}

function tokens(text) {
  let count = 0;
  for (const character of text) count += character.codePointAt(0) < 128 ? 0.25 : 1;
  return count;
}

function shortText(text, budget) {
  if (tokens(text) <= budget) return text;
  let output = "";
  let count = 0;
  for (const character of text) {
    const cost = tokens(character);
    if (count + cost + 0.75 > budget) break;
    output += character;
    count += cost;
  }
  return `${output}...`;
}

function boundOpen(result) {
  const size = () => tokens(JSON.stringify(result));
  const fields = [
    ...result.neighbors.toReversed().map((neighbor) => [neighbor, "summary"]),
    [result.note, "text"],
    ...result.neighbors.toReversed().flatMap((neighbor) => [[neighbor, "title"], [neighbor, "source"]]),
    [result.note, "title"],
    [result.note, "source"],
  ];
  for (const [object, key] of fields) {
    if (size() <= 800) break;
    if (typeof object[key] !== "string" || object[key].length === 0) continue;
    const characters = Array.from(object[key]);
    object[key] = "";
    if (size() > 800) continue;
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      object[key] = `${characters.slice(0, middle).join("")}...`;
      if (size() <= 800) low = middle;
      else high = middle - 1;
    }
    object[key] = low === 0 ? "" : `${characters.slice(0, low).join("")}...`;
  }
  while (size() > 800 && result.neighbors.length) result.neighbors.pop();
  if (size() > 800) throw new RangeError("Note metadata exceeds the open token budget");
  return result;
}

export function createMemory({ store, embedder, now = () => new Date(), onTouch = () => {} }) {
  if (!store || !embedder || typeof embedder.embed !== "function") {
    throw new TypeError("store and embedder are required");
  }
  if (!Number.isSafeInteger(embedder.dim) || embedder.dim < 1) {
    throw new TypeError("embedder.dim must be a positive integer");
  }
  if (typeof now !== "function" || typeof onTouch !== "function") {
    throw new TypeError("now and onTouch must be functions");
  }
  const writes = new Map();

  async function touch(user, op, source, nodeIds, at) {
    await onTouch({ user, op, source, nodeIds: [...new Set(nodeIds)], at });
  }

  async function embed(text) {
    const vectors = await embedder.embed([text]);
    if (
      !Array.isArray(vectors) ||
      vectors.length !== 1 ||
      !Array.isArray(vectors[0]) ||
      vectors[0].length !== embedder.dim ||
      !vectors[0].every(Number.isFinite)
    ) {
      throw new TypeError("embedder returned an invalid vector");
    }
    return vectors[0];
  }

  async function namedNode(user, label, name, at) {
    const [existing] = await store.findNodes({ user, label, where: { name }, limit: 1 });
    return existing ?? store.upsertNode({
      user,
      id: randomUUID(),
      labels: [label],
      props: { name, createdAt: at },
    });
  }

  async function resolve(user, { id, title }) {
    if (id !== undefined) {
      requiredString(id, "id");
      const node = await store.getNode({ user, id });
      if (node?.labels.some((label) => label === "Memory" || label === "Topic")) return node;
    } else {
      requiredString(title, "title");
      const [note] = await store.findNodes({ user, label: "Memory", where: { title }, limit: 1 });
      if (note) return note;
      const [topic] = await store.findNodes({ user, label: "Topic", where: { name: title }, limit: 1 });
      if (topic) return topic;
    }
    throw new Error("Memory or Topic not found");
  }

  return {
    async remember({
      user, source, kind, title, text, occurredAt, tags = [], summary, relatesTo = [],
      externalId, follows,
    }) {
      requiredString(user, "user");
      requiredString(source, "source");
      requiredString(title, "title");
      if (typeof text !== "string") throw new TypeError("text must be a string");
      if (!KINDS.has(kind)) throw new TypeError("Invalid memory kind");
      if (summary !== undefined && typeof summary !== "string") {
        throw new TypeError("summary must be a string");
      }
      externalReference(externalId, "externalId");
      externalReference(follows, "follows");
      const topics = stringArray(tags, "tags");
      const related = stringArray(relatesTo, "relatesTo");
      const occurred = occurredAt === undefined ? undefined : isoDate(occurredAt);
      // Serializing user writes keeps name-based Topic/Source creation unique.
      const write = async () => {
        const at = isoDate(now());
        const targets = [];
        for (const reference of related) {
          const byId = await store.getNode({ user, id: reference });
          targets.push(await resolve(user, byId ? { id: reference } : { title: reference }));
        }
        const embedding = await embed([title, text, topics.join(" ")].join("\n"));
        await store.ensureIndexes({ user, dim: embedder.dim });
        const id = externalId === undefined ? randomUUID() : externalMemoryId(externalId);
        const existing = externalId === undefined ? null : await store.getNode({ user, id });
        const replaced = existing !== null;
        const props = {
          title,
          text,
          summary: oneLine(summary ?? Array.from(text).slice(0, 80).join("")),
          kind,
          source,
          createdAt: at,
        };
        if (occurred !== undefined || kind === "event") props.occurredAt = occurred ?? at;
        else if (existing?.props.occurredAt !== undefined) props.occurredAt = null;
        if (externalId !== undefined) props.externalId = externalId;
        await store.upsertNode({ user, id, labels: ["Memory"], props, embedding });
        if (replaced) {
          await store.removeEdges({ user, id, types: REPLACED_EDGE_TYPES, direction: "out" });
        }
        const touched = [id];
        // Fetch one extra because the new, embedded note is itself a search hit.
        const matches = await store.vectorSearch({ user, embedding, k: 6, labels: ["Memory"] });
        const similar = matches.filter(({ node }) => node.id !== id).slice(0, 5)
          .filter(({ score }) => score >= 0.3).slice(0, 3);
        for (const { node, score } of similar) {
          const recency = Math.exp(-age(node, at) / 30);
          await store.addEdge({
            user, from: id, to: node.id, type: "SIMILAR",
            props: { w: 0.7 * score + 0.3 * recency },
          });
          touched.push(node.id);
        }
        for (const name of topics) {
          const topic = await namedNode(user, "Topic", name, at);
          await store.addEdge({ user, from: id, to: topic.id, type: "ABOUT", props: { w: 1 } });
          touched.push(topic.id);
        }
        const origin = await namedNode(user, "Source", source, at);
        await store.addEdge({ user, from: id, to: origin.id, type: "MENTIONED_BY" });
        touched.push(origin.id);
        for (const target of targets) {
          await store.addEdge({ user, from: id, to: target.id, type: "RELATES_TO" });
          touched.push(target.id);
        }
        let followsLinked;
        if (follows !== undefined) {
          const predecessor = await store.getNode({ user, id: externalMemoryId(follows) });
          followsLinked = Boolean(predecessor?.labels.includes("Memory"));
          if (followsLinked) {
            await store.addEdge({ user, from: predecessor.id, to: id, type: "NEXT_STEP" });
            touched.push(predecessor.id);
          }
        }
        await touch(user, "remember", source, touched, at);
        return { id, replaced, ...(follows === undefined ? {} : { followsLinked }) };
      };
      const previous = writes.get(user) ?? Promise.resolve();
      const pending = previous.then(write, write);
      writes.set(user, pending);
      return pending.finally(() => {
        if (writes.get(user) === pending) writes.delete(user);
      });
    },

    async open({ user, id, title, source }) {
      requiredString(user, "user");
      const at = isoDate(now());
      const node = await resolve(user, { id, title });
      const isTopic = node.labels.includes("Topic");
      let adjacent = await store.neighbors({
        user, id: node.id, types: isTopic ? ["ABOUT"] : undefined, limit: ALL,
      });
      if (isTopic) {
        adjacent = adjacent.filter(({ node: neighbor }) => neighbor.labels.includes("Memory"))
          .sort((a, b) =>
            dateOf(b.node) - dateOf(a.node) ||
            KIND_IMPORTANCE[b.node.props.kind] - KIND_IMPORTANCE[a.node.props.kind] ||
            (b.edge.props.w ?? 0) - (a.edge.props.w ?? 0));
      }
      const unique = new Map();
      for (const entry of adjacent) {
        if (!unique.has(entry.node.id)) unique.set(entry.node.id, entry);
      }
      const selected = [...unique.values()].slice(0, 5);
      const result = boundOpen({
        note: {
          id: node.id,
          title: titleOf(node),
          kind: kindOf(node),
          text: node.props.text ?? "",
          source: node.props.source ?? null,
          createdAt: node.props.createdAt,
          occurredAt: node.props.occurredAt ?? null,
          days_ago: daysAgo(node, at),
        },
        neighbors: selected.map(({ node: neighbor, edge }) => ({
          id: neighbor.id,
          title: titleOf(neighbor),
          summary: summaryOf(neighbor),
          kind: kindOf(neighbor),
          source: neighbor.props.source ?? null,
          w: edge.props.w ?? 0,
        })),
      });
      await touch(user, "open", source, [node.id, ...result.neighbors.map((neighbor) => neighbor.id)], at);
      return result;
    },

    async recall({ user, query, source, limit }) {
      requiredString(user, "user");
      requiredString(query, "query");
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new RangeError("limit must be a positive integer");
      }
      const at = isoDate(now());
      const embedding = await embed(query);
      const matches = await store.vectorSearch({ user, embedding, k: 10, labels: ["Memory"] });
      const candidates = new Map(matches.map(({ node, score }) => [node.id, { node, score }]));
      const topics = new Map();
      const question = query.normalize("NFKC").toLowerCase();
      for (const topic of await store.listNodes({ user, label: "Topic" })) {
        if (question.includes(topic.props.name.normalize("NFKC").toLowerCase())) {
          topics.set(topic.id, { node: topic, score: 1 });
        }
      }
      for (const { node, score } of matches) {
        for (const { node: topic } of await store.neighbors({
          user, id: node.id, types: ["ABOUT"], limit: ALL,
        })) {
          if (!topic.labels.includes("Topic")) continue;
          if (!topics.has(topic.id) || topics.get(topic.id).score < score) {
            topics.set(topic.id, { node: topic, score });
          }
        }
      }
      for (const { node: topic, score } of topics.values()) {
        for (const { node } of await store.neighbors({
          user, id: topic.id, types: ["ABOUT"], limit: ALL,
        })) {
          if (!node.labels.includes("Memory")) continue;
          if (!candidates.has(node.id) || candidates.get(node.id).score < score) {
            candidates.set(node.id, { node, score });
          }
        }
      }
      const ranked = [...candidates.values()]
        .sort((a, b) => b.score - a.score || dateOf(b.node) - dateOf(a.node))
        .slice(0, limit ?? ALL);
      const result = { preferences: [], recent_events: [], others: [], hint: null };
      for (const { node, score } of ranked) {
        const item = {
          id: node.id,
          title: node.props.title,
          summary: summaryOf(node),
          text: node.props.text,
          source: node.props.source,
          score,
        };
        if (node.props.kind === "preference") result.preferences.push(item);
        else {
          item.days_ago = daysAgo(node, at);
          if (node.props.kind === "event" && item.days_ago <= 7) result.recent_events.push(item);
          else result.others.push(item);
        }
      }
      result.recent_events.sort((a, b) => a.days_ago - b.days_ago || b.score - a.score);
      if (result.recent_events.length) {
        result.hint = "直近で済ませている可能性があります。提案する前に確認してください。";
      }
      await touch(user, "recall", source, [...candidates.keys(), ...topics.keys()], at);
      return result;
    },

    async orient({ user, source }) {
      requiredString(user, "user");
      const at = isoDate(now());
      const memoryCount = (await store.listNodes({ user, label: "Memory", limit: ALL })).length;
      const ranked = [];
      for (const topic of await store.listNodes({ user, label: "Topic" })) {
        if (isExcludedImportTopic(topic.props.name)) continue;
        const entries = (await store.neighbors({
          user, id: topic.id, types: ["ABOUT"], limit: ALL,
        })).filter(({ node }) => node.labels.includes("Memory"))
          .map(({ node }) => node).sort((a, b) => dateOf(b) - dateOf(a));
        if (!entries.length) continue;
        let importance = 0;
        for (const node of entries) {
          if (node.props.kind === "event" && daysAgo(node, at) <= 7) importance += 2;
          if (node.props.kind === "preference" || node.props.kind === "fact") importance += 1;
        }
        importance += Math.max(...entries.map((node) => Math.exp(-age(node, at) / 30)));
        const selected = ["preference", "event", "fact", "decision"]
          .map((kind) => entries.find((node) => node.props.kind === kind && orientSummaryOf(node)))
          .filter(Boolean).slice(0, 3);
        const count = new Set(entries.map((node) => node.id)).size;
        const broad = count >= BROAD_TOPIC_MIN_MEMORIES && count > memoryCount * BROAD_TOPIC_RATIO;
        ranked.push({ topic, entries, selected, importance, broad });
      }
      const visible = ranked.filter(({ selected }) => selected.length);
      const specific = visible.filter(({ broad }) => !broad);
      const candidates = specific.length ? specific : visible;
      candidates.sort((a, b) =>
        b.importance - a.importance || dateOf(b.entries[0]) - dateOf(a.entries[0]));
      const groups = new Map();
      for (const { topic, entries, selected } of candidates) {
        const key = JSON.stringify([...new Set(entries.map((node) => node.id))].sort());
        const group = groups.get(key);
        if (group) group.topics.push(topic);
        else groups.set(key, { topics: [topic], selected });
      }
      const lines = [GUIDE];
      const touched = [];
      for (const { topics, selected } of [...groups.values()].slice(0, 5)) {
        const fragments = selected.map((node) => {
          const days = daysAgo(node, at);
          const relative = days === 0 ? "今日" : days === 1 ? "昨日" : `${days}日前`;
          const label = {
            preference: "好み", event: relative, fact: "事実", decision: "決定",
          }[node.props.kind];
          return `${label}: ${shortText(orientSummaryOf(node), 45)}`;
        });
        const names = topics.map((topic) => oneLine(topic.props.name)).join("・");
        const line = `${shortText(names, 50)} — ${fragments.join(" / ")}`;
        if (tokens([...lines, line].join("\n")) > 400) break;
        lines.push(line);
        touched.push(...topics.map((topic) => topic.id), ...selected.map((node) => node.id));
      }
      if (!ranked.length) {
        lines.push("タグ付きの記憶はまだありません。");
        const [latest] = await store.listNodes({ user, label: "Memory", limit: 1 });
        if (latest) touched.push(latest.id);
      }
      await touch(user, "orient", source, touched, at);
      return lines.join("\n");
    },
  };
}
