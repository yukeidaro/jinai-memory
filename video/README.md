# Submission demo video v3.1

Produces a **2:00-3:00, 1920x1080, 30fps H.264 MP4 with no audio stream** and
nine representative PNGs. The default timeline is **138.5 seconds**; completed
captures can extend their own graph scenes, up to a 180-second total.
Product files and the two supplied Japanese conversation screenshots are
unchanged. The title, ChatGPT, Claude, FalkorDB and closing scenes retain their
existing content and 10/25/30/30/10-second lengths.

## Scenes and timing

| Default time | Scene |
| --- | --- |
| 0-10s | Jin AI Memory title |
| 10-35s | Actual ChatGPT screenshot and English translation |
| 35-53s | 2D: two ChatGPT-authored memories arrive; teal author count goes 2 -> 3 -> 4 |
| 53-83s | Actual Claude screenshot and English translation |
| 83-89s | 2D: selected dinner event with its ChatGPT author, date, summary and body |
| 89-95s | 2D: verified Group by AI, settled and fitted, showing all four clusters |
| 95-98.5s | Same graph, also in 3D. |
| 98.5-128.5s | Unchanged README-exact FalkorDB queries and bounded entry map |
| 128.5-138.5s | Unchanged closing message |

`buildTimeline()` is shared by the renderer, composition metadata, scene
sequences, still selection and output inspection. Each graph scene is at least
its default length, or `ceil(capture duration * 30)` frames if longer. For example,
a 20-second write capture gets 600 frames. Read/group use only their verified
six-second body windows, excluding setup and subsequent restoration. All later
scenes and stills move with measured write duration. Non-graph durations
never change. If a capture is shorter than its scene, its last image is held;
**motion inside a selected scene is not slowed down, sped up, cut or looped**.
The 3D capture must be 3-4 seconds and is recorded after the grouped 2D scene on
the same page, after restoring the 2D force layout.

If measured extensions push the whole timeline beyond three minutes, rendering
fails explicitly and asks for shorter capture waits. The default timeline
leaves 41.5 seconds of extension headroom. Do not solve an overrun by
speeding up footage or reducing the readable detail/group holds below five seconds.

## High-quality timestamped capture

`capture/capture.mjs` uses three fresh Chromium contexts, all opened with
`?view=2d`. It waits specifically for the visible `#graph2d canvas`, the 2D
toggle state, real graph data, live SSE and hidden error notices. Navigation,
CDN startup and initial layout settling happen **before** capture starts.
There is no Playwright `recordVideo` and no WebM extraction.

The frame recorder in `capture/capture.mjs` opens a Playwright `CDPSession` and calls:

```js
await session.send("Page.startScreencast", {
  format: "jpeg",
  quality: 94,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 1,
});
```

Every `Page.screencastFrame` receives a `Page.screencastFrameAck` with its
`sessionId`, including frames not saved. Saved timestamps come from the CDP
frame-swap `metadata.timestamp`, relative to the first captured frame.
The writer saves at most **8 JPEGs/second** (125ms spacing), dropping frames
while a disk write is pending rather than accumulating image buffers.
The 30fps output selects the latest captured frame whose timestamp is not in
the future. Missing frames therefore hold the previous image **without shifting
later events in time**. There is no optical interpolation or cross-fading between
captured images. Existing scene/caption entrance and exit fades remain.

At 20 seconds, the cadence allows at most about 160 JPEGs. Typical 100-300 KiB
frames would take about 16-47 MiB; these are estimates, not measured CI sizes.
There is a **64 MiB hard limit per scene** and byte totals are printed at capture
completion. Keep the 1080p frame size and quality >=92; lower the saved cadence
or shorten unnecessary waits if CI approaches the limit. Do not silently exhaust
the runner's disk. The renderer checks JPEG size headers and the same byte limit.
Final rendering uses PNG intermediates and H.264 CRF 16, avoiding another lossy
JPEG intermediate.

Only if CDP cannot start, provides no first frame within five seconds, or lacks
initial frame timestamps, capture prints a warning and switches to sequential
`page.screenshot({type: "jpeg", quality: 94, scale: "css"})` calls separated by
125ms. Screenshot timestamps use a monotonic clock, not an assumed frame rate.
CDP ACK, ongoing timestamp and disk-write failures propagate rather than becoming
success-shaped fallbacks. Capture stops the screencast and detaches its session
before closing its own page/context.

Generated files:

```text
public/ui-timing.json
public/frames/ui-write/000001.jpg ...
public/frames/ui-write/index.json
public/frames/ui-read/000001.jpg ...
public/frames/ui-read/index.json
public/frames/ui-group/000001.jpg ...
public/frames/ui-group/index.json
public/frames/ui-3d/000001.jpg ...
public/frames/ui-3d/index.json
```

Each index contains the scene, resolution, quality, capture method, measured
duration, byte total and ordered `{file, time}` entries (seconds from frame zero).
`ui-timing.json` version 2 points only to completed indexes and is published
incrementally. Read/group entries additionally contain
`body: {startSeconds, durationSeconds: 6, state, endState}`. The start is the
timestamp of a newly saved frame after the DOM state check, not an estimated
offset or a frame from before the check. Both states include `splitPressed`,
`splitLabel`, `detailsVisible`, `detailTitle`, `detailSource`, `detailKind` and
`browserHidden`. No machine-specific timestamps, tokens or URLs appear in indexes.
Generated frames and manifests are ignored by Git. A new capture removes only
the four named generated frame directories and its manifest; it never changes
the supplied images.

### Framing and action holds

Only public buttons, memory-list items and mouse input control the UI. Capture
does not access or modify private product state, graph internals, camera APIs,
CSS or image assets.

- **Fit and position:** after data settles, click `#fit-view`, wait 1.2s, zoom out
  with a +220 wheel event, then drag the upper canvas 120 CSS pixels right.
  These values are in `FRAMING` with the reason beside them: clear the left
  legend, which ends near x=318, while retaining room for node labels.
  This replaces the old 3D-specific wheel-zoom assumption. Actual node placement
  and label clearance must still be checked visually in CI.
- **Write:** show the baseline briefly, save the first ChatGPT note and wait for
  its author count to reach 3; wait 2.5s, save the dated event and wait for count 4;
  allow arrivals to settle, fit/position again and hold four seconds.
- **Read:** Claude calls `orient` and opens both notes. After the server-side
  access highlight, Browse memories selects the exact dinner event. Capture
  asserts its visible title, ChatGPT author, event kind, occurrence date, summary
  and body. Click the browser-only `#browse-close` (never Escape), leave the
  right detail panel open, allow one second for the 700ms selection movement,
  then verify and hold **6.5 seconds**, using the first **6 seconds** as the scene.
- **Group:** click Group by AI and wait for `aria-pressed="true"` and
  `Restore force layout`. Wait the full **12-second settling cap**, then fit and
  position through the unchanged `fit2D()` helper, including its 1.2s post-fit
  wait. The product reheats a 220-tick simulation, clusters toward four author
  centers with strength 0.16 and fits on engine stop with a 700ms transition.
  The cap is a conservative wait, not proof of pixel convergence on a slow CI
  runner; visually inspect the resulting clusters. Verify the pressed state,
  hold **6.5 seconds**, and use the first **6 seconds** as the scene. After
  capture stops, restore the force layout before switching to 3D.
- **3D:** after the group capture completes, click `#view-toggle` on that same
  page, wait for the 3D canvas and toggle state, settle and fit outside capture,
  then record about **3.5 seconds**. It shows the same data, not a new graph.

Representative read/group stills are selected at second five of their verified
six-second body windows, inside their held states. The 3D still is also from its actual
capture. Graph captions and caveats stay inset from the left legend and right
detail panel; caption lengths follow measured scene frames.

## Honesty and unavailable recordings

UI scenes retain **Scripted MCP replay / fictional demo notes** and
**Local in-memory store / fake embeddings**. They are not recordings of the
original ChatGPT/Claude tool calls or a live FalkorDB session. The existing
conversation screenshots and their English translations are preserved.
The write subtitle continues to identify FalkorDB as the persistent backend,
not as the backend used by this disposable CI capture.

The read caveat remains: **Highlights record server-side memory access, not
proof of model reasoning.** `slowed playback` was removed because frames now play
at their captured times. The 400-token map size remains an estimate, including
the in-memory 2,000-note check, not a tokenizer or database-latency benchmark.
Per-user graphs are namespaced, not a full multi-account authentication claim.

No manifest, an uncompleted scene, a missing index, or any missing JPEG makes
that entire scene show **RECORDING UNAVAILABLE**; other completed scenes still
render. Read/group never show their claim subtitles when unavailable. They also
fall back with a warning if their body timing, exact start frame, full six-second
coverage or beginning/end state is missing or invalid. Group requires the string
`splitPressed: "true"` and `Restore force layout`; read requires a fully visible,
non-hidden detail panel, a title containing `ハンバーグ`, ChatGPT as author,
event kind, and a closed browser. Older v3 read/group manifests without this
evidence intentionally fall back; write/3D inputs are unchanged.
Invalid JSON, paths, timestamps, quality,
dimensions or corrupt JPEG headers fail explicitly. Direct Remotion usage
without generated props also defaults to the clearly labeled unavailable scenes.

Raw browser errors and token-bearing URLs are withheld. Capture logs its stage
and error class; check local health, jsDelivr access, WebGL and live events at
that stage. The frame capture includes only the viewport, not browser chrome.

## Running elsewhere (npm-capable machine or CI only)

Use Node.js 22 or newer. No npm/npx, browser capture, dependency installation or
Remotion rendering was run on the implementation PC.

```powershell
Push-Location .\video
npm install --no-audit --no-fund
npx playwright install --with-deps chromium
Pop-Location
```

Start a **fresh disposable loopback server**, with in-memory storage and fake
embeddings, using a newly generated token, as in the existing workflow. Do not
load real account credentials or production data. Once `/healthz` returns 200,
set `JINAI_URL` to that loopback HTTP origin and `JINAI_TOKEN` to its disposable
token, then run in `video`:

```powershell
npm run verify
npm run capture
npm run render
npm run stills
npm run inspect
```

Capture refuses non-loopback URLs and nonempty graphs. Restart your own disposable
server before repeating capture. Do not use `?mock=1`; the captures need real
local HTTP/MCP operations and live events. The product needs its existing
jsDelivr imports; Remotion downloads Chrome Headless Shell on first render.

Checks available on this PC, without installing anything:

```powershell
Get-ChildItem .\video\capture\*.mjs | ForEach-Object { node --check $_.FullName }
node --check .\video\render.mjs
node --check .\video\src\timeline.mjs
node --check .\video\verify.mjs
node .\video\verify.mjs
node --test
```

`verify.mjs` checks the real disposable HTTP/MCP scenario, CDP **mocks** and
screenshot fallback, timestamp selection with irregular gaps, completed/partial/
missing frame inputs, JPEG headers and path guards, verified body offsets,
beginning/end state failures, suppression of unavailable read/group captions,
six-second window coverage, dynamic timeline extension, unchanged non-graph lengths,
nine still positions, README-exact Cypher and output-format guards. Header
fixtures do not verify JPEG decoding. Node checks do not compile JSX or prove
visual sharpness.

Local v3.1 results (2026-10-18; no browser capture):

| Check | Result |
| --- | --- |
| `node --check` for both capture modules, renderer, timeline and verifier | Passed |
| `node video/verify.mjs` | Passed: real local HTTP/MCP scenario, CDP/screenshot markers, body/state/window guards and static caption wiring |
| Root `node --test` | 210 passed, 0 failed, 0 skipped |
| Static scene comparison against HEAD | Intro, both conversation components/props, FalkorDB and outro unchanged |
| Product selector and 2D query grep | Existing in `public/index.html`, `public/app.js`, `public/view-mode.js`, `public/graph2d.js` |
| Product paths and supplied image diff | No changes |
| Browser capture / JSX build / Remotion / Actions | Not run locally |

## GitHub Actions

The existing workflow still uses Node 22, `ubuntu-latest`, a 30-minute job
limit, `contents: read`, no secrets, and a newly masked disposable local token.
It installs the existing pinned packages and Chromium, runs verification,
starts its own local server, checks health, then captures/renders/inspects.
Capture remains `continue-on-error`, allowing explicit unavailable-scene output.
Only this job's saved server PID is used for cleanup.

The earlier v3 workflow changes were limited to the nine-still step label and
replacing the obsolete WebM artifact glob with `video/public/frames/`.
No workflow changes were made for v3.1. Artifacts remain available
for seven days, even if a later step fails:

- `out/demo.mp4`, `out/stills/` (nine PNGs), `out/still-index.json`.
- `out/media-info.json` (actual duration, size, fps and zero audio streams).
- `out/render-props.json`, local server log and saved server PID.
- `public/ui-timing.json` and `public/frames/` (JPEGs and timestamp indexes).

`inspect` probes the actual MP4 using Remotion FFprobe and compares its length
to the same measured timeline, enforcing 1920x1080, 30fps, H.264 and no audio.
Rendering and sparse still extraction both use concurrency 2.

**CI acceptance, to be checked by Claude/Yu:** check all four completed capture
entries, byte totals, all nine stills and the full MP4. Confirm two teal writes,
readable Japanese node labels and crisp lines, the correct ChatGPT/date/body in
the right panel for >=5s, all four grouped clusters held for >=5s, and the actual
3D view for 3-4s. Check final duration is 2:00-3:00. A green fallback render is a
diagnostic artifact, not a finished submission video.

Remaining CI risks: experimental CDP availability and optional timestamps (with
explicit screenshot fallback), jsDelivr/WebGL/SSE readiness, Japanese font
availability, force-layout framing and legend clearance, JPEG bytes per scene,
the first Remotion browser download, and PNG/CRF-16 rendering time under the
30-minute job limit. Real capture, JSX compilation, MP4 quality and Actions
execution remain unverified locally.

## Official API references

Checked for v3:

- [Playwright CDPSession](https://playwright.dev/docs/api/class-cdpsession):
  `page.context().newCDPSession(page)`, `send`, `on` and `detach`.
- [CDP Page.startScreencast](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast).
- [CDP Page.screencastFrame](https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-screencastFrame),
  [screencastFrameAck](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-screencastFrameAck)
  and [stopScreencast](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-stopScreencast).
- [Official CDP JSON schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json):
  directly checked the JPEG format, quality range 0-100, integer maxWidth/
  maxHeight, positive everyNthFrame, integer sessionId and optional frame-swap
  timestamp (`Network.TimeSinceEpoch`). The current documentation site redirects
  old anchors to its new client-side viewer, so the authoritative schema was
  also inspected directly.
- [Playwright screenshot](https://playwright.dev/docs/api/class-page#page-screenshot).
- [Remotion calculateMetadata](https://www.remotion.dev/docs/calculate-metadata):
  dynamic composition duration from props.
- [Remotion Img](https://www.remotion.dev/docs/img),
  [staticFile](https://www.remotion.dev/docs/staticfile),
  [useCurrentFrame](https://www.remotion.dev/docs/use-current-frame) and
  [CLI rendering](https://www.remotion.dev/docs/cli/render).

Existing package pins are unchanged: `remotion` and `@remotion/cli` 4.0.536,
React and React DOM 19.2.3, Playwright 1.64.1. They were not installed or
revalidated through package downloads for this change.

## Decisions and rejected approaches

Use high-quality JPEGs with timestamp-based sample-and-hold, not compressed
Playwright WebM, guessed clip durations, tail trims or frame-count-based playback.
Save at 8fps for disk headroom while rendering the final video at 30fps.
Keep CDP as the primary method; screenshots are only its explicit fallback.
Fit/pan through the real 2D controls, not product changes or synthetic graphs.
Keep static scenes and supplied image assets unchanged. Retain all honest replay,
storage, embedding and server-access disclosures; remove only the now-inaccurate
slowed-playback disclosure.

For v3.1, exclude read/group setup using verified timestamps rather than guessing
caption delays or trusting a final still alone. Use the permitted 12-second
settling cap rather than product globals or canvas instrumentation. Restore only
after recording. No actual browser-capture alternatives were executed on this PC.

## Remotion license

Remotion 4 is source-available, not an unrestricted MIT dependency. Individuals
and for-profit companies with up to three employees can use it free, including
commercially. Larger for-profit organizations need a Company License; see
[the official terms](https://www.remotion.dev/license). The product repository's
AGPL license is unchanged.
