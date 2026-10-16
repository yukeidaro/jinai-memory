# Store contract (shared by memory layer and FalkorDB adapter)

All modules are ES modules, Node 24, **no npm dependencies** (the dev PC cannot reach registry.npmjs.org). Use only `node:*` built-ins and `fetch`. Tests use `node --test`.

## Store (`src/store/*.js`)

A store is an object created by a factory and exposes these async methods. Every method takes `user` (string) and operates only on that user's graph (FalkorDB graph name: `memory:<user>`).

```
ensureIndexes({ user, dim })                      -> void   // vector index on Memory.embedding, range index on id
upsertNode({ user, id, labels, props, embedding? }) -> node  // id is a caller-made string (uuid). labels: string[]. props: flat JSON-safe object.
getNode({ user, id })                             -> node | null
findNodes({ user, label?, where?, limit? })       -> node[]  // where: exact-match on props, e.g. { name: "ハンバーグ" }
listNodes({ user, label?, sinceIso?, limit? })    -> node[]  // ordered by props.createdAt desc
addEdge({ user, from, to, type, props? })         -> edge    // upsert: same (from,to,type) updates props
neighbors({ user, id, types?, limit })            -> [{ node, edge }]  // ordered by edge.props.w desc (missing w = 0)
vectorSearch({ user, embedding, k, labels? })     -> [{ node, score }] // score = cosine similarity, higher = closer
close()                                           -> void
```

`node` = `{ id, labels: string[], props: object }`. `edge` = `{ from, to, type, props }`. `embedding` is never returned inside `props`.

Implementations: `src/store/falkordb-store.js` (the product; talks to FalkorDB through `src/falkordb-client.js`), `src/store/memory-store.js` (in-process, used only by unit tests and offline dev; same contract).

## FalkorDB client (`src/falkordb-client.js`)

```
createClient({ url })  // url like rediss://default:PASSWORD@host:port  or redis://localhost:6379
  -> { query(graph, cypher, params?) -> { header: string[], rows: any[][], stats: object }, close() }
```
Speaks RESP2 over `node:net` / `node:tls`, issues `GRAPH.QUERY <graph> <cypher> --compact`, decodes nodes/edges/scalars. Parameters are passed with the `CYPHER name=value ...` prefix (strings escaped, arrays supported, e.g. `vecf32([...])` for vectors).

## Memory layer (`src/memory.js`)

```
createMemory({ store, embedder, now = () => new Date(), onTouch = () => {} })
  remember({ user, source, kind, title, text, occurredAt?, tags?, summary?, relatesTo? }) -> { id }
  open({ user, id?, title?, source? })   -> { note, neighbors }   // note md body; neighbors max 5 by weight, each with one-line summary
  recall({ user, query, source?, limit? }) -> { preferences, recent_events, others, hint }
  orient({ user })                       -> string                 // "map", <= 400 tokens
```
`source`: `"claude" | "chatgpt" | "cursor" | "copilot" | string`. `kind`: `"preference" | "event" | "fact" | "decision"`.
`onTouch({ user, op: "remember"|"open"|"recall"|"orient", source, nodeIds: string[], at: ISO })` fires after every call (the UI consumes it).

## Embedder (`src/embedder.js`)

```
createEmbedder({ provider: "openai" | "fake", apiKey?, model = "text-embedding-3-small", dim })
  -> { dim, embed(texts: string[]) -> number[][] }
```
`openai` calls `POST https://api.openai.com/v1/embeddings` with `fetch`. `fake` is deterministic (hash based), same text -> same vector, similar words share dimensions; used by tests.
