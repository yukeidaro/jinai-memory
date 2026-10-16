import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resolveRuntimeConfig } from "../src/config.js";

test("no backend configuration selects memory and fake with 128 dimensions", () => {
  const config = resolveRuntimeConfig({});
  assert.equal(config.store, "memory");
  assert.equal(config.embeddings, "fake");
  assert.equal(config.dim, 128);
  assert.equal(Object.hasOwn(config, "falkordbUrl"), false);
  assert.ok(config.notes.includes("store: memory"));
  assert.ok(config.notes.some((note) => /embeddings: fake.*no OPENAI_API_KEY/u.test(note)));
});

test("FalkorDB alone selects persistent storage independently of fake embeddings", () => {
  const env = Object.freeze({ FALKORDB_URL: randomUUID() });
  const config = resolveRuntimeConfig(env);
  assert.equal(config.store, "falkordb");
  assert.equal(config.falkordbUrl, env.FALKORDB_URL);
  assert.equal(config.embeddings, "fake");
  assert.equal(config.dim, 128);
  assert.ok(config.notes.includes("store: falkordb"));
});

test("FalkorDB and an OpenAI key select falkordb and openai with 1536 dimensions", () => {
  const config = resolveRuntimeConfig({
    FALKORDB_URL: randomUUID(), OPENAI_API_KEY: randomUUID(),
  });
  assert.equal(config.store, "falkordb");
  assert.equal(config.embeddings, "openai");
  assert.equal(config.dim, 1536);
});

test("an OpenAI key alone selects openai without changing memory storage", () => {
  const config = resolveRuntimeConfig({ OPENAI_API_KEY: randomUUID() });
  assert.equal(config.store, "memory");
  assert.equal(config.embeddings, "openai");
  assert.equal(config.dim, 1536);
});

test("explicit fake overrides an OpenAI key without changing falkordb storage", () => {
  const config = resolveRuntimeConfig({
    FALKORDB_URL: randomUUID(), OPENAI_API_KEY: randomUUID(), EMBEDDINGS_PROVIDER: "fake",
  });
  assert.equal(config.store, "falkordb");
  assert.equal(config.embeddings, "fake");
  assert.equal(config.dim, 128);
});

test("explicit openai requires a nonblank key", () => {
  for (const OPENAI_API_KEY of [undefined, "", " \t"]) {
    assert.throws(() => resolveRuntimeConfig({
      EMBEDDINGS_PROVIDER: "openai", OPENAI_API_KEY,
    }), /OPENAI_API_KEY is required/u);
  }
  const config = resolveRuntimeConfig({
    EMBEDDINGS_PROVIDER: "openai", OPENAI_API_KEY: randomUUID(),
  });
  assert.equal(config.embeddings, "openai");
  assert.equal(config.dim, 1536);
});

test("blank keys default to fake and unsupported providers reject explicitly", () => {
  for (const OPENAI_API_KEY of ["", " \t"]) {
    assert.equal(resolveRuntimeConfig({ OPENAI_API_KEY }).embeddings, "fake");
  }
  for (const EMBEDDINGS_PROVIDER of ["", "other", "OpenAI"]) {
    assert.throws(() => resolveRuntimeConfig({ EMBEDDINGS_PROVIDER }), /EMBEDDINGS_PROVIDER/u);
  }
});

test("EMBED_DIM overrides the default for either embeddings provider", () => {
  for (const EMBEDDINGS_PROVIDER of ["fake", "openai"]) {
    const config = resolveRuntimeConfig({
      EMBEDDINGS_PROVIDER, OPENAI_API_KEY: randomUUID(), EMBED_DIM: "256",
    });
    assert.equal(config.dim, 256);
  }
  assert.equal(resolveRuntimeConfig({ EMBED_DIM: "1" }).dim, 1);
});

test("invalid EMBED_DIM values reject rather than silently using a default", () => {
  for (const EMBED_DIM of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "invalid", "1e2", "0x10", "9007199254740992"]) {
    assert.throws(() => resolveRuntimeConfig({ EMBED_DIM }), /EMBED_DIM must be a positive integer/u);
  }
});

test("notes never include the configured URL, API key, or token", () => {
  const env = Object.freeze({
    FALKORDB_URL: randomUUID(), OPENAI_API_KEY: randomUUID(), MEMORY_TOKEN: randomUUID(),
  });
  for (const EMBEDDINGS_PROVIDER of ["fake", "openai"]) {
    const { notes } = resolveRuntimeConfig({ ...env, EMBEDDINGS_PROVIDER });
    assert.ok(notes.every((note) => typeof note === "string"));
    for (const value of Object.values(env)) {
      assert.equal(notes.some((note) => note.includes(value)), false);
    }
  }
});
