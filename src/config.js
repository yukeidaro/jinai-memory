export function resolveRuntimeConfig(env) {
  const store = env.FALKORDB_URL ? "falkordb" : "memory";
  const hasKey = typeof env.OPENAI_API_KEY === "string" && Boolean(env.OPENAI_API_KEY.trim());
  const embeddings = env.EMBEDDINGS_PROVIDER ?? (hasKey ? "openai" : "fake");
  if (embeddings !== "fake" && embeddings !== "openai") {
    throw new TypeError("EMBEDDINGS_PROVIDER must be fake or openai");
  }
  if (embeddings === "openai" && !hasKey) {
    throw new TypeError("OPENAI_API_KEY is required for openai embeddings");
  }
  const dim = env.EMBED_DIM === undefined
    ? embeddings === "openai" ? 1536 : 128
    : Number(env.EMBED_DIM);
  if (
    (env.EMBED_DIM !== undefined && !/^\d+$/u.test(env.EMBED_DIM)) ||
    !Number.isSafeInteger(dim) || dim < 1
  ) {
    throw new RangeError("EMBED_DIM must be a positive integer");
  }
  const notes = [
    `store: ${store}`,
    `embeddings: ${embeddings}${embeddings === "fake" && !hasKey ? " (no OPENAI_API_KEY)" : ""}`,
    `dim: ${dim}`,
  ];
  let users;
  if (env.MEMORY_USERS !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(env.MEMORY_USERS);
    } catch {
      throw new TypeError("MEMORY_USERS must be a valid JSON object of user names and tokens");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length) {
      throw new TypeError("MEMORY_USERS must be a nonempty JSON object of user names and tokens");
    }
    const tokens = new Set();
    users = Object.entries(parsed).map(([user, token]) => {
      if (!/^[A-Za-z0-9_-]{1,40}$/u.test(user)) {
        throw new TypeError("MEMORY_USERS user names must contain 1-40 letters, digits, underscores or hyphens");
      }
      if (typeof token !== "string" || !token.trim() || token.length < 24) {
        throw new TypeError("MEMORY_USERS tokens must be nonblank strings of at least 24 characters");
      }
      if (tokens.has(token)) throw new TypeError("MEMORY_USERS tokens must be unique");
      tokens.add(token);
      return { user, token };
    });
    if (env.MEMORY_TOKEN !== undefined) {
      notes.push("MEMORY_USERS takes precedence over MEMORY_TOKEN and MEMORY_USER.");
    }
  } else {
    users = [{ user: env.MEMORY_USER ?? "demo", token: env.MEMORY_TOKEN }];
  }
  if (users.some(({ token }) => typeof token === "string" && /[^A-Za-z0-9._~-]/u.test(token))) {
    notes.push("Memory tokens require URL encoding. Encode the token component in connector and screen URLs.");
  }
  return {
    store,
    ...(store === "falkordb" ? { falkordbUrl: env.FALKORDB_URL } : {}),
    embeddings,
    dim,
    users,
    notes,
  };
}
