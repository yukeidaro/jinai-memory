const ALL = Number.MAX_SAFE_INTEGER;

export async function buildSnapshot({ store, user, now = () => new Date() }) {
  const generatedAt = now().toISOString();
  const groups = await Promise.all([
    store.listNodes({ user, label: "Memory", limit: 500 }),
    store.listNodes({ user, label: "Topic" }),
    store.listNodes({ user, label: "Source" }),
  ]);
  const nodes = new Map(groups.flat().map((node) => {
    const memory = node.labels.includes("Memory");
    return [node.id, {
      id: node.id,
      type: memory ? "memory" : node.labels.includes("Topic") ? "topic" : "source",
      label: memory ? node.props.title : node.props.name,
      kind: memory ? node.props.kind ?? null : null,
      source: memory ? node.props.source ?? null : null,
      summary: memory ? node.props.summary ?? "" : "",
      text: memory ? Array.from(node.props.text ?? "").slice(0, 8_000).join("") : "",
      tags: [],
      createdAt: node.props.createdAt ?? null,
      occurredAt: memory ? node.props.occurredAt ?? null : null,
    }];
  }));
  const links = new Map();
  for (const id of nodes.keys()) {
    for (const { edge } of await store.neighbors({ user, id, limit: ALL })) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
      const key = JSON.stringify([edge.from, edge.to, edge.type]);
      if (links.has(key)) continue;
      links.set(key, {
        source: edge.from,
        target: edge.to,
        type: edge.type,
        w: edge.props.w ?? 1,
      });
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (
        edge.type === "ABOUT" && from.type === "memory" && to.type === "topic" &&
        !from.tags.includes(to.label)
      ) {
        from.tags.push(to.label);
      }
    }
  }
  return { user, generatedAt, nodes: [...nodes.values()], links: [...links.values()] };
}
