# Store contract (shared by memory layer and FalkorDB adapter)

All modules are ES modules, Node 24, **no npm dependencies** (the dev PC cannot reach registry.npmjs.org). Use only `node:*` built-ins and `fetch`. Tests use `node --test`.

## Store (`src/store/*.js`)

A store is an object created by a factory and exposes these async methods. Every method takes `user` (string) and operates only on that user's graph (FalkorDB graph name: `memory:<user>`).

```
ensureIndexes({ user, dim })                      -> void   // vector index on Memory.embedding, range index on id
upsertNode({ user, id, labels, props, embedding? }) -> node  // id is a caller-made string (uuid or deterministic external id). labels: string[]. props: flat JSON-safe object.
getNode({ user, id })                             -> node | null
findNodes({ user, label?, where?, limit? })       -> node[]  // where: exact-match on props, e.g. { name: "ハンバーグ" }
listNodes({ user, label?, sinceIso?, limit? })    -> node[]  // ordered by props.createdAt desc
addEdge({ user, from, to, type, props? })         -> edge    // upsert: same (from,to,type) updates props
removeEdges({ user, id, types, direction })        -> void   // types: string[], direction: "out" | "both" (both required)
neighbors({ user, id, types?, limit })            -> [{ node, edge }]  // ordered by edge.props.w desc (missing w = 0)
vectorSearch({ user, embedding, k, labels? })     -> [{ node, score }] // score = cosine similarity, higher = closer
close()                                           -> void
```

Semantics: `neighbors` follows edges in **both directions** (each result's `edge` keeps its real `from`/`to`). `vectorSearch` only considers nodes that have an embedding. `props.createdAt` / `props.occurredAt` are ISO strings set by the caller. Label conventions used by the memory layer: `Memory` (a note; the only label with an embedding), `Topic`, `Source`; edge types `ABOUT` (Memory->Topic), `MENTIONED_BY` (Memory->Source), `SIMILAR` (Memory<->Memory, `props.w`), `RELATES_TO`, `NEXT_STEP`.

`removeEdges` deletes only the specified types incident to `id` in the caller's graph: `"out"` deletes outgoing edges, while `"both"` also deletes incoming edges. Other types, other nodes' edges, and all nodes/properties/embeddings are preserved. Empty `types` or a missing node is a no-op; invalid types or direction reject. Repeating a removal is safe.

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
  remember({ user, source, kind, title, text, occurredAt?, tags?, summary?, relatesTo?, externalId?, follows? })
    -> { id, replaced: boolean, followsLinked?: boolean }
  open({ user, id?, title?, source? })   -> { note, neighbors }   // note md body; neighbors max 5 by weight, each with one-line summary
  recall({ user, query, source?, limit? }) -> { preferences, recent_events, others, hint }
  orient({ user })                       -> string                 // "map", <= 400 tokens
```
`source`: `"claude" | "chatgpt" | "cursor" | "copilot" | string`. `kind`: `"preference" | "event" | "fact" | "decision"`.
`onTouch({ user, op: "remember"|"open"|"recall"|"orient", source, nodeIds: string[], at: ISO })` fires after every call (the UI consumes it).

`externalId` and `follows` are optional strings matching `[A-Za-z0-9:_.-]{1,200}`. They are intended for import tools; conversational AI normally omits them. `externalId` is stored in the Memory's props and maps to `ext-` plus the first 32 hexadecimal characters of its SHA-256 hash. Within one user's graph, resending it replaces the same Memory's title, text, summary, kind, source, timestamps, embedding, and outgoing `ABOUT`, `MENTIONED_BY`, `SIMILAR`, and `RELATES_TO` edges. An omitted non-event `occurredAt` clears an old value (null or absent); `createdAt` is the current write time. All incoming edges and all `NEXT_STEP` edges are preserved. Old Topic/Source nodes are not deleted. `replaced` is true only when that Memory already existed in the caller's graph. Without `externalId`, every call still creates a fresh UUID Memory and returns `replaced: false`.

When `follows` identifies an existing Memory in the same user's graph, `remember` upserts one `NEXT_STEP` edge from that predecessor to the saved Memory and returns `followsLinked: true`. A missing predecessor is not an error, creates no placeholder, and returns `followsLinked: false`; retry after importing the predecessor to link it. `followsLinked` is omitted when `follows` is omitted. Repeated imports do not duplicate Memories or edges; replacements still fire `onTouch`, including the predecessor in `nodeIds` when linked.

## Embedder (`src/embedder.js`)

```
createEmbedder({ provider: "openai" | "fake", apiKey?, model = "text-embedding-3-small", dim })
  -> { dim, embed(texts: string[]) -> number[][] }
```
`openai` calls `POST https://api.openai.com/v1/embeddings` with `fetch`. `fake` is deterministic (hash based), same text -> same vector, similar words share dimensions; used by tests.
