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

test("MEMORY_TOKEN retains the default user and legacy token and namespace formats", () => {
  assert.deepEqual(resolveRuntimeConfig({ MEMORY_TOKEN: "legacy-token" }).users, [
    { user: "demo", token: "legacy-token" },
  ]);
  assert.deepEqual(resolveRuntimeConfig({
    MEMORY_TOKEN: "legacy-token", MEMORY_USER: "legacy:user",
  }).users, [{ user: "legacy:user", token: "legacy-token" }]);
});

test("MEMORY_USERS resolves multiple users and takes precedence over legacy settings", () => {
  const demo = randomUUID();
  const yu = randomUUID();
  const config = resolveRuntimeConfig({
    MEMORY_USERS: JSON.stringify({ demo, yu }), MEMORY_TOKEN: "", MEMORY_USER: "ignored",
  });
  assert.deepEqual(config.users, [{ user: "demo", token: demo }, { user: "yu", token: yu }]);
  assert.ok(config.notes.some((note) => /MEMORY_USERS takes precedence over MEMORY_TOKEN/u.test(note)));
});

test("MEMORY_USERS rejects invalid JSON and anything other than a nonempty object without echoing input", () => {
  const token = randomUUID();
  for (const MEMORY_USERS of ["", " ", `{"demo":"${token}"`, "null", "[]", '["token"]', "{}", "42", '"text"']) {
    assert.throws(() => resolveRuntimeConfig({ MEMORY_USERS, MEMORY_TOKEN: randomUUID() }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /MEMORY_USERS/u);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});

test("MEMORY_USERS validates user names at the 1 and 40 character boundaries", () => {
  for (const user of ["a", "A_0-z", "a".repeat(40), "__proto__"]) {
    const token = randomUUID();
    assert.deepEqual(resolveRuntimeConfig({
      MEMORY_USERS: JSON.stringify({ [user]: token }),
    }).users, [{ user, token }]);
  }
  for (const user of ["", "a".repeat(41), "has space", "user:name", "user/name", "user.name", "user\nname", "ユーザー"]) {
    const token = randomUUID();
    assert.throws(() => resolveRuntimeConfig({
      MEMORY_USERS: JSON.stringify({ [user]: token }),
    }), (error) => {
      assert.match(error.message, /MEMORY_USERS user names/u);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  }
});

test("MEMORY_USERS requires nonblank string tokens of at least 24 characters", () => {
  for (const token of ["", "a".repeat(23), " ".repeat(24), null, 123, {}, []]) {
    assert.throws(() => resolveRuntimeConfig({
      MEMORY_USERS: JSON.stringify({ demo: token }),
    }), /MEMORY_USERS tokens must be nonblank strings of at least 24/u);
  }
  const token = "a".repeat(24);
  assert.deepEqual(resolveRuntimeConfig({
    MEMORY_USERS: JSON.stringify({ demo: token }),
  }).users, [{ user: "demo", token }]);
});

test("MEMORY_USERS rejects duplicate tokens without disclosing them", () => {
  const token = randomUUID();
  assert.throws(() => resolveRuntimeConfig({
    MEMORY_USERS: JSON.stringify({ demo: token, yu: token }),
  }), (error) => {
    assert.match(error.message, /MEMORY_USERS tokens must be unique/u);
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

test("URL-unsafe tokens warn without preventing startup or disclosing any token", () => {
  const safe = `${randomUUID()}._~`;
  for (const suffix of ["+", "/", "=", "%", " ", "?", "#", "あ"]) {
    const unsafe = randomUUID() + suffix;
    for (const env of [
      { MEMORY_TOKEN: unsafe },
      { MEMORY_USERS: JSON.stringify({ demo: safe, yu: unsafe }), MEMORY_TOKEN: randomUUID() },
    ]) {
      const config = resolveRuntimeConfig(env);
      assert.ok(config.users.some(({ token }) => token === unsafe));
      assert.ok(config.notes.some((note) => /require URL encoding/u.test(note)));
      for (const token of [safe, unsafe, env.MEMORY_TOKEN].filter(Boolean)) {
        assert.equal(config.notes.some((note) => note.includes(token)), false);
      }
    }
  }
  for (const env of [
    { MEMORY_TOKEN: safe },
    { MEMORY_USERS: JSON.stringify({ demo: safe }) },
  ]) {
    assert.equal(resolveRuntimeConfig(env).notes.some((note) => /URL encoding/u.test(note)), false);
  }
});

test("multi-user notes never contain legacy or active tokens, backend URLs, or API keys", () => {
  const secrets = [randomUUID(), randomUUID() + "+/=", randomUUID(), randomUUID(), randomUUID()];
  const { notes } = resolveRuntimeConfig({
    MEMORY_USERS: JSON.stringify({ demo: secrets[0], yu: secrets[1] }),
    MEMORY_TOKEN: secrets[2], FALKORDB_URL: secrets[3], OPENAI_API_KEY: secrets[4],
  });
  for (const secret of secrets) assert.equal(notes.some((note) => note.includes(secret)), false);
});
