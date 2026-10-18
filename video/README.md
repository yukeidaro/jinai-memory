# Submission demo video

This folder produces a **170-second, 1920x1080, 30fps H.264 MP4 without an audio
track**, plus eight representative PNGs. It does not modify the product.
The two supplied Japanese conversation screenshots remain unchanged; English
translations explain the actual exchanges. No invented AI conversation is shown.

## What the video shows

| Time | Scene |
| --- | --- |
| 0-10s | Jin AI Memory and the shared-memory promise |
| 10-35s | Actual ChatGPT screenshot: proactively saved preference and dated meal |
| 35-55s | Enlarged product UI: scripted ChatGPT MCP writes and incoming nodes |
| 55-85s | Actual Claude screenshot: the next-day dinner question and memory check |
| 85-105s | Claude `orient` and `open`, then zoom into the dinner event with its body and ChatGPT attribution |
| 105-130s | Group by AI: settle, fit all four clusters, hold, then briefly restore |
| 130-160s | Three README-exact FalkorDB Cypher queries and bounded entry map |
| 160-170s | Closing message, repository and hackathon credit |

The UI recordings are **scripted MCP replays with fictional notes**, not
recordings of the original ChatGPT/Claude tool calls. Each UI scene says so.
The CI server intentionally uses **in-memory storage and fake embeddings** with
no database credentials. It does not demonstrate a live FalkorDB connection.
The database scene explains the implemented FalkorDB persistent adapter using
the root README's actual queries. For this reason the write subtitle says
"FalkorDB is the persistent backend", rather than falsely saying this CI capture
saved data in FalkorDB.

Highlights show server-side memory access, not proof of a model's reasoning.
The 400-token bound is an **estimated** map size, including at 2,000 notes in
the repository's in-memory response-size check, not a real-tokenizer or
database-latency benchmark. Per-user graphs are namespaced, not a claim of a
full multi-account authentication service.

## Local use (only where npm is available)

Use Node.js 22 or newer. From the repository root in PowerShell:

```powershell
Push-Location .\video
npm install --no-audit --no-fund
npx playwright install --with-deps chromium
Pop-Location

# Only a fresh, disposable local server. Never use a real account token.
$env:MEMORY_TOKEN = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$env:JINAI_TOKEN = $env:MEMORY_TOKEN
$env:JINAI_URL = "http://127.0.0.1:8787"
$env:PORT = "8787"
$env:MEMORY_USER = "video-demo"
$env:EMBEDDINGS_PROVIDER = "fake"
$env:EMBED_DIM = "128"
$env:FALKORDB_URL = ""
$env:OPENAI_API_KEY = ""
Remove-Item Env:MEMORY_USERS -ErrorAction SilentlyContinue
$server = Start-Process node -ArgumentList ".\src\server.js" -NoNewWindow -PassThru

# Wait for "Listening on port 8787", then confirm HTTP 200 before capture:
(Invoke-WebRequest http://127.0.0.1:8787/healthz).StatusCode

Push-Location .\video
try {
  npm run verify
  npm run capture
  npm run render
  npm run stills
  npm run inspect
} finally {
  Pop-Location
  Stop-Process -Id $server.Id
}
```

On Linux, install in `video/`, use the same environment values, and run
`node src/server.js` from the root before running the video scripts.
No production host, personal files, AI account login or secrets are needed.
The product browser does need network access to its existing jsDelivr imports.
Remotion also downloads Chrome Headless Shell on its first render.

Capture refuses non-loopback URLs and nonempty graphs. Restart the disposable
server before repeating capture. Do not enable `?mock=1`: capture waits for
the real graph and the real live-event connection.

### Recordings and missing-footage behavior

Three separate pages/contexts produce `public/ui-write.webm`,
`public/ui-read.webm` and `public/ui-group.webm`. Each page waits for the real
canvas, a nonempty snapshot and live SSE, then settles for five seconds.
Before each action segment, capture clicks **Fit view**, waits 1.5 seconds,
then sends three centered wheel events of -360, 250ms apart, and waits another
second. With the pinned Three.js r160 OrbitControls at device scale 1, this
is about 1.74x zoom, targeting 60-75% graph width; actual framing must
be checked in CI because software WebGL and layout positions can vary.
Wheel interaction follows Fit view so automatic fitting does not undo it.

The write scene saves the first ChatGPT memory, waits 3.5 seconds, saves the
second, waits four seconds for arrivals, fits/zooms again, then holds four
seconds. The read scene refreshes the map, opens both dinner notes, and uses
**Browse memories** to select the ChatGPT-authored dinner event. It checks the
visible title, author, kind, date, summary and body, then closes only the browser
with its toggle (not Escape), allows 1.5 seconds for the camera, and holds the
open details for eight seconds. Group by AI settles for eight seconds, fits
and zooms the separated layout, holds for seven seconds, and restores for three.
The held shots finish before the product's ten-second idle auto-orbit resumes.
Only public buttons, list items and mouse input control the graph; no product
state or camera API is accessed by capture.
The event's occurrence time is one day before capture, retaining its time of
day so the product's whole-24-hour `days_ago` calculation returns one.

`public/ui-timing.json` is published incrementally after each completed clip.
Only completed clips are made available to the renderer. Remotion's FFprobe
reads the actual WebM duration; tail-anchored trims remove variable page/CDN
startup time, include a small lead-in, and slow the write/read/group action
segments to 20/20/25 seconds without looping or inventing frames. Overlong
action segments fail explicitly rather than speeding playback up or reducing
the readable holds below six seconds. The manifest is regenerated with measured
action lengths on every capture; no guessed WebM durations are checked in.
The read/group representative stills fall late in their scenes, targeting the
open memory and settled grouping, not the initial overview or restored layout.
Graph-only captions use 28px text below the graph, inset beyond the left legend
and right detail panel. The replay and access caveats remain, also inset so
they do not cover the legend or the selected memory's title/body.
Temporary recordings are removed
when capture exits normally or fails through its error handler.

`npm run render` and `npm run stills` check the manifest and file existence
before passing props to the composition. With no capture they still render
black graph scenes labeled **RECORDING UNAVAILABLE**, retaining the English
subtitles. A partial capture uses only the completed existing clips. A corrupt
manifest or invalid media raises an explicit error rather than concealing it.
Directly running the Remotion CLI without the generated props deliberately
uses the same no-footage default.

No token-bearing URLs or raw browser errors are logged. The browser recording
contains only the viewport, not address bars. Capture prints the failing stage
and error class; check local health, jsDelivr access, WebGL and live-event
readiness at that stage. Do not add raw URLs or account data to public artifacts.

## GitHub Actions

`.github/workflows/demo-video.yml` runs on pushes to `video/demo` affecting
`video/**` or the workflow, and on `workflow_dispatch`. It uses Node 22 on
`ubuntu-latest`, a 30-minute job limit, `contents: read`, and no `secrets.*`.

It installs the pinned video dependencies with `npm install` (no supplied
lockfile), installs Playwright Chromium and Linux libraries, verifies the demo
scenario, generates a new masked disposable token, starts the product on 8787,
and polls `/healthz`. The capture step has `continue-on-error`; failure emits a
warning, and rendering/stills continue with the clearly labeled fallback.
Artifacts are uploaded even after later failure and retained for **7 days**.
Only this job's own saved server PID is used for cleanup.

The artifact contains:

- `out/demo.mp4`: the submission video.
- `out/stills/`: eight PNG frames, one per scene.
- `out/still-index.json`: scene names, seconds and frame numbers.
- `out/media-info.json`: probed duration, dimensions, frame rate and audio count.
- `out/render-props.json`, `out/server.log`, `out/server.pid`: diagnostics without tokens.
- `public/ui-*.webm` and `public/ui-timing.json`: completed raw UI clips and timing.

`npm run inspect` uses **Remotion's FFprobe**, logs media properties and fails
unless the actual output is H.264, 170 seconds (within one frame), 1920x1080,
30fps and has no audio stream. Eight stills are rendered in one CLI invocation
with its documented sparse `--frames` option. Rendering uses concurrency 2,
one video decoder thread and a 256 MiB video-frame cache for CI memory headroom.

**Before submission:** inspect the capture step outcome, all eight PNGs,
`media-info.json`, and the whole MP4. A green job with missing-footage warnings
is useful for diagnosis, not a finished submission video.

## Pinned packages and official API references

These exact versions were confirmed via jsDelivr package metadata:

| Package | Version | Metadata |
| --- | --- | --- |
| `remotion` | `4.0.536` | [package.json](https://cdn.jsdelivr.net/npm/remotion@4.0.536/package.json) |
| `@remotion/cli` | `4.0.536` | [package.json](https://cdn.jsdelivr.net/npm/@remotion/cli@4.0.536/package.json) |
| `react` | `19.2.3` | [package.json](https://cdn.jsdelivr.net/npm/react@19.2.3/package.json) |
| `react-dom` | `19.2.3` | [package.json](https://cdn.jsdelivr.net/npm/react-dom@19.2.3/package.json) |
| `playwright` (dev) | `1.64.1` | [package.json](https://cdn.jsdelivr.net/npm/playwright@1.64.1/package.json) |

React/React DOM match the versions used in the pinned Remotion packages'
development metadata. Both direct Remotion packages have the same version.

Official references checked for this implementation:
[registerRoot](https://www.remotion.dev/docs/register-root),
[Composition](https://www.remotion.dev/docs/composition),
[Sequence](https://www.remotion.dev/docs/sequence),
[AbsoluteFill](https://www.remotion.dev/docs/absolute-fill),
[useCurrentFrame](https://www.remotion.dev/docs/use-current-frame),
[Img](https://www.remotion.dev/docs/img),
[staticFile](https://www.remotion.dev/docs/staticfile),
[OffthreadVideo](https://www.remotion.dev/docs/offthreadvideo),
[interpolate](https://www.remotion.dev/docs/interpolate),
[CLI render, props, frames and muted](https://www.remotion.dev/docs/cli/render),
[FFprobe](https://www.remotion.dev/docs/cli/ffprobe),
[Playwright video recording](https://playwright.dev/docs/videos).
The JSX uses `OffthreadVideo` with `staticFile`, `trimBefore`,
`durationInFrames`, `playbackRate` and `muted`; no TypeScript is used.

## Remotion license

Remotion 4 is source-available, not an unrestricted MIT dependency.
Individuals and for-profit companies with **up to three employees** can use
it free, including commercially. Larger for-profit organizations need a
Company License. See the [official terms](https://www.remotion.dev/license).
The product repository's own AGPL license is unchanged.

## Implementation decisions / work log

Hypothesis: separate real UI recordings plus validated metadata allow a
170-second composition to render independently of capture success.

The v2 timeline changes only the three graph scene lengths; the title,
conversation, FalkorDB and closing scenes keep their v1 content and lengths.
Screenshots have a slow 1.0-1.035
Ken Burns zoom without cropping their content; subtitles fade in/out.
Arial/Helvetica and system monospace avoid extra font packages or downloads.
The three recording contexts avoid uncertain single-video scene boundaries;
FFprobe tail anchoring avoids counting network startup as action footage.
The initial single-WebM plan was replaced by separate clips to make scene
boundaries explicit.

Rejected: simulated graphs, synthetic AI chat, a real database service or
production tokens, and an assumption that highlights prove model reasoning.
Rejected: direct imports of recordings/timing into JSX, which would fail a
bundle when recordings do not exist. File validation happens before rendering
and the composition defaults to an empty clip list.

The brief requests `.copilot-runs/notes/t12.md` but also expressly prohibits
all edits outside `video/` and this workflow. The prohibition takes priority:
this allowed README contains the work log instead.

Local validation on Node 24:

| Check | Result |
| --- | --- |
| `node --check video/capture/capture.mjs` | Passed |
| `node --check` for `scenario.mjs`, `render.mjs`, `timeline.mjs`, `verify.mjs` | Passed |
| `node video/verify.mjs` | Passed: actual HTTP/MCP scenario, four authors, yesterday's event, Claude reads, access events and zero read embeddings |
| Rendering-input assertions in `verify.mjs` | Passed: 5,100 contiguous frames, unchanged non-graph scene lengths, eight representative still positions, README-exact Cypher, missing/partial-file fallback, all three clip timings, no speed-up and output-format guards |
| Root `node --test` | 196 tests: 195 passed, 1 opt-in real-FalkorDB test skipped, 0 failed |
| JSX inspection | Manually checked balanced tags/braces, local imports and all Remotion import names against official docs; not compiled locally |
| Workflow inspection | Manually reviewed structure, Bash steps and expressions; text assertions confirm no tabs, even indentation and the three action references pinned to `@v4` |
| Dependency versions | All five exact versions confirmed via the linked jsDelivr metadata |

The initial README-query assertion exposed Windows CRLF versus JavaScript LF;
the verifier now normalizes only the read string, without editing the product
README. An LF-format check also caught this editor's Windows line endings;
all new deliverables are normalized to LF before handoff.
No YAML parser was installed; do not interpret the formatting assertions as
full YAML/schema validation.

Browser capture, JSX compilation, Remotion rendering and Actions execution
were **not run locally**; no dependency installation was attempted on this PC.
First CI risks to inspect: browser CDN/WebGL/SSE readiness, first-render Chrome
download, media extraction and runtime/memory under the 30-minute job limit.
For v2, also check that graph width actually reaches 60-75%, all four AI
clusters fit without clipping, the read still shows the correct body and
ChatGPT badge, and slower UI operations do not overrun the 20/20/25-second
scene budgets. These visual results are not verified by local Node checks.
