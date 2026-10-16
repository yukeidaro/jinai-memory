import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbedder } from "./embedder.js";
import { createEventHub } from "./events.js";
import { createMcpHandler } from "./mcp.js";
import { createMemory } from "./memory.js";
import { createFalkorDBStore } from "./store/falkordb-store.js";
import { createMemoryStore } from "./store/memory-store.js";

const MAX_BODY = 1_048_576;
const DEFAULT_PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

function sameToken(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function outside(root, target) {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function staticFile(res, publicDir, pathname) {
  const target = path.resolve(publicDir, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (outside(publicDir, target)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }
  let filename;
  let details;
  try {
    const root = await realpath(publicDir);
    filename = await realpath(target);
    if (outside(root, filename)) {
      json(res, 403, { error: "Forbidden" });
      return;
    }
    details = await stat(filename);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      json(res, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
  if (!details.isFile()) {
    json(res, 404, { error: "Not found" });
    return;
  }
  const stream = createReadStream(filename);
  stream.on("error", () => {
    if (res.headersSent) res.destroy();
    else json(res, 500, { error: "Could not read file" });
  });
  res.on("close", () => stream.destroy());
  res.setHeader("Content-Type", MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  stream.pipe(res);
}

async function mcpRequest(req, res, handle, ctx) {
  const contentType = req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    req.resume();
    json(res, 415, { error: "Content-Type must be application/json" });
    return;
  }
  if (Number(req.headers["content-length"]) > MAX_BODY) {
    req.resume();
    json(res, 413, { error: "Request body is too large" });
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume();
      json(res, 413, { error: "Request body is too large" });
      return;
    }
    chunks.push(chunk);
  }
  let message;
  try {
    message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  let response;
  if (Array.isArray(message) && message.length > 0) {
    const responses = [];
    // Keep writes ordered, including batches that write and then read the map.
    for (const item of message) {
      const reply = await handle(item, ctx);
      if (reply !== undefined) responses.push(reply);
    }
    response = responses.length ? responses : undefined;
  } else {
    response = await handle(message, ctx);
  }
  if (response === undefined) {
    res.writeHead(202);
    res.end();
  } else {
    json(res, 200, response);
  }
}

export function createServer({ memory, hub, token, user = "demo", publicDir = DEFAULT_PUBLIC }) {
  if (typeof token !== "string" || !token.trim()) throw new TypeError("A nonempty token is required");
  if (typeof user !== "string" || !user.trim()) throw new TypeError("A nonempty user is required");
  const handle = createMcpHandler({ memory });
  const root = path.resolve(publicDir);
  return createHttpServer(async (req, res) => {
    try {
      const rawPath = req.url.split("?", 1)[0];
      let pathname;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        json(res, rawPath.startsWith("/mcp/") ? 404 : 400, { error: "Invalid URL" });
        return;
      }
      if (pathname.startsWith("/mcp/")) {
        const prefix = `/mcp/${token}-`;
        const source = pathname.slice(prefix.length);
        if (
          !sameToken(pathname.slice(5, 5 + token.length), token) ||
          !pathname.startsWith(prefix) || !/^[a-z0-9-]{1,20}$/u.test(source)
        ) {
          json(res, 404, { error: "Not found" });
          return;
        }
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        await mcpRequest(req, res, handle, { user, source });
        return;
      }
      // Check before URL normalization, on both Windows and POSIX separators.
      if (
        !pathname.startsWith("/") || /[\0:\\]/u.test(pathname) ||
        pathname.split("/").some((part) => part === "..")
      ) {
        json(res, 403, { error: "Forbidden" });
        return;
      }
      if (pathname === "/events") {
        const url = new URL(req.url, "http://localhost");
        if (!sameToken(url.searchParams.get("token"), token)) {
          json(res, 404, { error: "Not found" });
          return;
        }
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET");
          json(res, 405, { error: "Method not allowed" });
          return;
        }
        hub.subscribe(res, { user });
        return;
      }
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      if (pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      await staticFile(res, root, pathname);
    } catch {
      if (res.headersSent || res.destroyed) res.destroy();
      else json(res, 500, { error: "Internal server error" });
    }
  });
}

async function start() {
  const token = process.env.MEMORY_TOKEN;
  if (!token?.trim()) {
    console.error("MEMORY_TOKEN is required. Set $env:MEMORY_TOKEN='<your-random-token>' and run node src/server.js.");
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error("PORT must be an integer between 0 and 65535.");
    process.exitCode = 1;
    return;
  }
  const user = process.env.MEMORY_USER ?? "demo";
  const development = !process.env.FALKORDB_URL || !process.env.OPENAI_API_KEY;
  const dim = development ? 128 : 1536;
  const store = development
    ? createMemoryStore()
    : createFalkorDBStore({ url: process.env.FALKORDB_URL });
  try {
    const embedder = createEmbedder({
      provider: development ? "fake" : "openai",
      apiKey: process.env.OPENAI_API_KEY,
      dim,
    });
    await store.ensureIndexes({ user, dim });
    const hub = createEventHub();
    const memory = createMemory({ store, embedder, onTouch: hub.publish });
    const server = createServer({ memory, hub, token, user });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, resolve);
    });
    if (development) console.log("開発モード: memory-store + fake embedder (not persisted).");
    console.log(`Listening on port ${server.address().port}; MCP: /mcp/***-<source>`);
    const shutdown = () => {
      server.close();
      server.closeAllConnections();
      store.close().catch(() => {
        console.error("Could not close memory store.");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    await store.close();
    throw new Error("Server startup failed. Check port and memory backend configuration.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(() => {
    console.error("Server startup failed. Check port and memory backend configuration.");
    process.exitCode = 1;
  });
}
