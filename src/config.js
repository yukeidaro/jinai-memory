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
  return {
    store,
    ...(store === "falkordb" ? { falkordbUrl: env.FALKORDB_URL } : {}),
    embeddings,
    dim,
    notes,
  };
}
