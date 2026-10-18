export function seedMemories() {
  return [
    {
      source: "chatgpt",
      arguments: {
        kind: "preference", title: "Simple weekday dinners",
        summary: "Fictional demo: simple dinners with vegetables.",
        text: "Fictional demo note. Prefer simple weekday dinners with vegetables.",
        tags: ["dinner", "meal planning", "夕飯"],
      },
    },
    {
      source: "chatgpt",
      arguments: {
        kind: "decision", title: "Keep preferences separate from meals",
        summary: "Fictional demo: a preference is not a dated meal.",
        text: "Fictional demo note. Store food preferences separately from dated dinner events.",
        tags: ["dinner", "meal planning", "夕飯"],
        relatesTo: ["Simple weekday dinners"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "preference", title: "Quiet waterside walks",
        summary: "Fictional demo: enjoy quiet walks and sketches.",
        text: "Fictional demo note. Enjoy quiet waterside walks and sketching.",
        tags: ["travel", "walking", "sketching"],
      },
    },
    {
      source: "claude",
      arguments: {
        kind: "fact", title: "Check pantry before shopping",
        summary: "Fictional demo: check inventory before making a list.",
        text: "Fictional demo note. Check the pantry before planning dinner and shopping.",
        tags: ["shopping", "meal planning", "dinner"],
        relatesTo: ["Simple weekday dinners"],
      },
    },
    {
      source: "cursor",
      arguments: {
        kind: "decision", title: "Meal planner data model",
        summary: "Fictional demo: separate preferences and dated events.",
        text: "Fictional demo note. The meal planner separates preferences from dinner history.",
        tags: ["meal planning", "design", "dinner"],
        relatesTo: ["Keep preferences separate from meals"],
      },
    },
    {
      source: "cursor",
      arguments: {
        kind: "fact", title: "Event dates are separate fields",
        summary: "Fictional demo: occurrence and creation dates differ.",
        text: "Fictional demo note. Keep a meal's occurrence date separate from its note creation date.",
        tags: ["meal planning", "design", "dates"],
        relatesTo: ["Meal planner data model"],
      },
    },
    {
      source: "copilot",
      arguments: {
        kind: "fact", title: "Shopping list script",
        summary: "Fictional demo: subtract pantry items from ingredients.",
        text: "Fictional demo note. A prototype shopping list removes ingredients already in the pantry.",
        tags: ["shopping", "meal planning", "script"],
        relatesTo: ["Check pantry before shopping", "Meal planner data model"],
      },
    },
    {
      source: "copilot",
      arguments: {
        kind: "decision", title: "Deduplicate shopping items",
        summary: "Fictional demo: normalize ingredient names.",
        text: "Fictional demo note. Trim ingredient names and merge duplicate shopping items.",
        tags: ["shopping", "script", "ingredients"],
        relatesTo: ["Shopping list script"],
      },
    },
  ];
}

export function dinnerMemories(now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return [
    {
      kind: "preference",
      title: "ハンバーグが好き",
      summary: "昔からハンバーグが好き。デミグラスソースも気に入っている。",
      text: "## 好み\n昔からハンバーグが好き。デミグラスソースで作るとおいしい。\n\n架空のデモ用再演。",
      tags: ["ハンバーグ", "夕飯", "献立", "dinner"],
      relatesTo: ["Simple weekday dinners"],
    },
    {
      kind: "event",
      title: "夕飯にデミグラスのハンバーグを作った",
      summary: "昨日の夕飯にデミグラスソースのハンバーグを作った。",
      text: "## 昨日の夕飯\nデミグラスソースのハンバーグを作り、おいしく食べた。\n\n架空のデモ用再演。好みとは別の、日付のある出来事。",
      occurredAt: yesterday.toISOString(),
      tags: ["ハンバーグ", "夕飯", "献立", "dinner"],
      relatesTo: ["ハンバーグが好き"],
    },
  ];
}

export function captureConfig(env) {
  let base;
  try {
    base = new URL(env.JINAI_URL);
  } catch {
    throw new Error("JINAI_URL must be a loopback HTTP URL.");
  }
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username || base.password || base.pathname !== "/" || base.search || base.hash
  ) {
    throw new Error("Capture only accepts a loopback HTTP origin without credentials or query parameters.");
  }
  if (typeof env.JINAI_TOKEN !== "string" || !env.JINAI_TOKEN.trim()) {
    throw new Error("JINAI_TOKEN must contain the disposable local capture token.");
  }
  return { base, token: env.JINAI_TOKEN };
}

export function createDemoClient({ base, token }) {
  let sequence = 0;
  async function request(url, options, label) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`${label}: local request failed (URL and token withheld).`);
    }
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${label}: invalid JSON response.`);
    }
  }
  return {
    async snapshot() {
      const url = new URL("/api/graph", base);
      url.searchParams.set("token", token);
      const result = await request(url, {}, "Graph snapshot");
      if (!Array.isArray(result?.nodes) || !Array.isArray(result?.links)) {
        throw new Error("Graph snapshot has an invalid shape.");
      }
      return result;
    },
    async call(source, name, args = {}) {
      const id = ++sequence;
      const url = new URL(`/mcp/${encodeURIComponent(token)}-${source}`, base);
      const reply = await request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id, method: "tools/call",
          params: { name, arguments: args },
        }),
      }, `${source} ${name}`);
      if (
        reply?.jsonrpc !== "2.0" || reply.id !== id || reply.error ||
        reply.result?.isError || !Array.isArray(reply.result?.content)
      ) {
        throw new Error(`${source} ${name}: MCP operation was rejected.`);
      }
      let value;
      try {
        value = JSON.parse(reply.result.content.find((item) => item.type === "text")?.text);
      } catch {
        throw new Error(`${source} ${name}: invalid tool result.`);
      }
      if (name === "remember" && (typeof value?.id !== "string" || !value.id)) {
        throw new Error(`${source} remember: missing memory id.`);
      }
      if (name === "open" && typeof value?.note?.id !== "string") {
        throw new Error(`${source} open: missing memory note.`);
      }
      if (name === "orient" && typeof value !== "string") {
        throw new Error(`${source} orient: invalid memory map.`);
      }
      return value;
    },
  };
}
