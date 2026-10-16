function validDimension(dim) {
  if (!Number.isSafeInteger(dim) || dim < 1) {
    throw new RangeError("dim must be a positive integer");
  }
}

function hash(text) {
  let value = 2166136261;
  for (const character of text) {
    value = Math.imul(value ^ character.codePointAt(0), 16777619);
  }
  return value >>> 0;
}

function fakeEmbedding(text, dim) {
  const vector = Array(dim).fill(0);
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const add = (feature, weight) => {
    const value = hash(feature);
    vector[value % dim] += (value & 0x80000000 ? -1 : 1) * weight;
  };

  for (const word of words) {
    add(`word:${word}`, 1.5);
    const characters = Array.from(word);
    for (let size = 1; size <= 3; size += 1) {
      for (let start = 0; start + size <= characters.length; start += 1) {
        add(`${size}:${characters.slice(start, start + size).join("")}`, size === 1 ? 0.25 : 1);
      }
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

export function createEmbedder({
  provider,
  apiKey,
  model = "text-embedding-3-small",
  dim,
}) {
  validDimension(dim);
  if (provider !== "fake" && provider !== "openai") {
    throw new TypeError("provider must be fake or openai");
  }
  if (provider === "openai" && (typeof apiKey !== "string" || !apiKey.trim())) {
    throw new TypeError("An OpenAI API key is required");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new TypeError("model must be a nonempty string");
  }

  return {
    dim,
    async embed(texts) {
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string")) {
        throw new TypeError("texts must be an array of strings");
      }
      if (texts.length === 0) return [];
      if (provider === "fake") return texts.map((text) => fakeEmbedding(text, dim));

      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, input: texts, dimensions: dim }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI embeddings request failed (HTTP ${response.status})`);
      }

      const { data } = await response.json();
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error("OpenAI returned an invalid embeddings response");
      }
      const vectors = Array(texts.length);
      for (const item of data) {
        if (
          !item ||
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= texts.length ||
          vectors[item.index] !== undefined ||
          !Array.isArray(item.embedding) ||
          item.embedding.length !== dim ||
          !item.embedding.every(Number.isFinite)
        ) {
          throw new Error("OpenAI returned an invalid embedding");
        }
        vectors[item.index] = item.embedding;
      }
      return vectors;
    },
  };
}
