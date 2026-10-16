# HTTP API for the UI (served by `src/server.js`)

All endpoints take the shared secret as `?token=<MEMORY_TOKEN>` (same token as in the MCP URL). Wrong or missing token -> 404. CORS: `Access-Control-Allow-Origin: *`.

## `GET /api/graph?token=...`
Snapshot of the whole graph of the single demo user.

```json
{
  "user": "demo",
  "generatedAt": "2026-10-17T03:00:00.000Z",
  "nodes": [
    {
      "id": "uuid",
      "type": "memory | topic | source",
      "label": "ハンバーグが好き",
      "kind": "preference | event | fact | decision | null",
      "source": "chatgpt | claude | cursor | copilot | ... | null",
      "summary": "one line",
      "text": "Markdown body (memory only, may be empty)",
      "tags": ["ハンバーグ", "夕飯"],
      "createdAt": "ISO",
      "occurredAt": "ISO | null"
    }
  ],
  "links": [
    { "source": "uuid", "target": "uuid", "type": "ABOUT | MENTIONED_BY | SIMILAR | RELATES_TO | NEXT_STEP", "w": 0.0 }
  ]
}
```
`type: "memory"` nodes carry `kind` and `source`. `topic` nodes have `label = name`. `source` nodes (the AI tools) have `label = tool name`. `w` defaults to 1 when the edge has no weight. Each link appears once.

## `GET /events?token=...` (SSE)
Each message is `data: {"user":"demo","op":"remember|open|recall|orient","source":"claude","nodeIds":["uuid",...],"at":"ISO"}`. `nodeIds` are the nodes touched by that call (for `remember`: the new node plus the nodes it was linked to).

## Static files
`GET /` serves `public/index.html`. The page reads the token from its own URL (`/?token=...`) and passes it to the two endpoints above. `?mock=1` makes the page run entirely on built-in sample data with simulated events (no server calls).
