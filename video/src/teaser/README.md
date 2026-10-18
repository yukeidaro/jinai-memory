# Jin AI Memory: 55-second illustrated demo

`JinAIMemoryDemo` is a separate, silent **1920x1080, 30 fps, 1650-frame**
composition. `Root.jsx` retains the existing `Demo` registration unchanged in
behavior. No capture, renderer, workflow, product code, or original demo
component is changed.

## Files and continuity

- `kit.jsx`: named motion primitives, deterministic SVG stars/graph, camera,
  punch-in, dock, window, typing, cascade, chips, dimming and tile-to-input morph.
- `JinAIMemoryDemo.jsx`: one persistent stage, window and graph across five acts.
- `timeline.mjs`: pure timing, copy, frame drivers and validation functions.
- `check-timeline.mjs`: runnable timing checks and limited source/import guards.

| Frames (end exclusive) | Action |
| --- | --- |
| 0-360 | Claude Code terminal; review the dry run, append `--yes`, import into an amber graph, count to 114 |
| 360-720 | The same window folds into ChatGPT; a burger preference and dated dinner event arrive as two teal nodes |
| 720-1110 | The window folds into Claude; an amber read path reaches the same teal memories; the answer highlights `yesterday` |
| 1110-1440 | The window minimizes; the existing graph expands, revealing FalkorDB write/read/map details and README-exact Cypher |
| 1440-1650 | Graph and dock contract into the J tile; the tile becomes the repository input; final message holds |

There are no scene fades, cuts, crossfades or wipes. Window content changes at
the narrow midpoint of its 12-frame fold. The same graph component keeps the
same node IDs, positions and authorship across tools. Captions and the dock
remain outside the punch-in transform so the 1.25x emphasis cannot crop them.
Only the small star backdrop fades away during the specified closing morph.

## Facts and presentation decisions

The import shows the brief's measured counts: 71 skills, 16 memory files,
17 CLAUDE.md sections, 19 Claude Code sessions, zero secrets skipped and
114 imported memories. These are separate measurements, not a sum. After the
ChatGPT writes, the badge says `Shared memory` rather than implying that 114
is still the live total. The graph's decorative points are illustrative, not
a one-dot-per-record reconstruction. The visible `Illustrated demo` label
distinguishes this animation from a recording of real tool calls.

The conversation is the fixed Oct 17/next-day example from the brief, not the
render machine's current date. Only ChatGPT, Claude, Claude Code and Jin AI
initial tiles appear; no vendor artwork, recordings, images, network requests,
external fonts or audio are used. Generic MCP compatibility appears as text.
UI/captions use system sans-serif; typed content uses system monospace.
The compact 520x56 closing input uses 22px repository text; window body text
is at least 28px and subtitles/tagline are at least 40px.

The specific f1560-f1650 schedule and acceptance check take precedence over
the general "last 1.5 seconds" wording: the final hold is **90 frames** with
only camera drift. Camera scale gently oscillates with a maximum rate of
approximately 1.5% per second, avoiding an unbounded zoom that would crop UI.
The two read-by chip states are settled/readable for at least 36 frames each,
rather than cycling faster than the allotted 110 frames permits.

## Local acceptance checks

From the repository root, without package installation:

```powershell
node --check .\video\src\teaser\timeline.mjs
node --check .\video\src\teaser\check-timeline.mjs
node .\video\src\teaser\check-timeline.mjs
node --test
git diff --check
git status --short
```

The timing validator uses the same pure frame drivers as visible geometry,
typing, cursor, scan bar, graph movement, read particle and closing lettering.
It excludes camera/stars as evidence of scene activity and rejects any
15-frame still interval before f1560. Negative controls inject a 15-frame
pause, a 35-frame caption and a 1649-frame timeline to confirm rejection.
Complete answers and settled read-by chips are included in readability checks.
All frame drivers remain finite and freeze after f1560 except the camera.

The source guards check relative named imports, the exact composition
registration, the README query and the documented Remotion import whitelist.
They are **not a JSX parser, browser layout check or video render**. JSX and
non-JSX code/imports were also reviewed manually.

Local results (2026-10-18):

| Check | Result |
| --- | --- |
| `node --check` for both new `.mjs` files | Passed |
| `node video/src/teaser/check-timeline.mjs` | Passed: 1650 frames, 55 seconds; no >=15-frame idle run before f1560; final 90-frame hold |
| Caption/answer/chip readability | Passed: 13 states, each at least 36 frames |
| Timing negative controls and finite frame drivers | Passed |
| Relative named imports, API whitelist, registration, Cypher and asset/audio guards | Passed |
| Root `node --test` | 210 passed, 0 failed, 0 skipped |
| Existing `Demo` registration compared with HEAD | Identical apart from indentation |
| Protected demo/product/render/workflow paths | No diff |
| `git diff --check` | Passed |
| JSX compilation, Remotion render and MP4 inspection | Not run locally |

Only the following Remotion APIs are used by the new components; names and
arguments were checked against their official documentation:

- [Composition](https://www.remotion.dev/docs/composition)
- [AbsoluteFill](https://www.remotion.dev/docs/absolute-fill)
- [useCurrentFrame](https://www.remotion.dev/docs/use-current-frame)
- [interpolate](https://www.remotion.dev/docs/interpolate)
- [spring](https://www.remotion.dev/docs/spring)
- [Easing](https://www.remotion.dev/docs/easing)

Spring entrances use damping 18/stiffness 180. Spawn is nine frames,
minimize twelve, title folds twelve, tile morph ten and dock collapse thirty.
Repeated entrances use 15/15/8/8... frames, with default cascade starts three
frames apart. The punch-in goes 1 -> 1.25 over six frames, then 1.25 -> 0.92
over nine, followed by a gentle return.

## CI handoff

Rendering belongs to the separate CI agent. No npm/npx, dependency
installation, JSX build, browser render, MP4 encode or GitHub Actions run was
performed on this PC. Do not treat passing Node checks as rendered acceptance.

CI should select **JinAIMemoryDemo**, not the existing `Demo`, and inspect the
whole MP4 plus frames near 242, 300, 560, 840, 950, 1109, 1140, 1300, 1470,
1540 and 1649. Confirm the amber import waterfall, exactly two teal arrivals,
read path, full answer/read-by line, all three technical cards, uncropped
captions and repository text, smooth folds/morphs, 55-second duration and no
audio stream. System font metrics, SVG label collisions, overflow during
spring overshoot and Chromium's treatment of very small transforms still
require actual rendered inspection. Pinned packages remain unchanged:
Remotion 4.0.536 and React 19.2.3.
