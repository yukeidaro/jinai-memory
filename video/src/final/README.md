# Jin AI Memory final video
- Put recordings in `video/public/final/`: `02-install.mp4`, `03-settings.mp4`, `04-chatgpt-claudecode.mp4`, `05-claude.mp4`.
- Edit each recording's `caption` (and pending-card `label`) in `timeline.mjs`.
- Run `node measure-final.mjs` from `video` to regenerate `public/final/durations.json` with system `ffprobe`; missing recordings are logged and stored as `null`.
- Length = 5s intro + four measured recordings (each rounded up to 30fps, capped at 25s; missing = 4s) + 10s closing.
- No recordings = 31s; about 70s requires about 55s of recordings. Maximum total = 115s; footage is not stretched.
- `calculateFinalMetadata` loads that manifest; do not hand-edit it when adding recordings. Invalid recordings fail instead of silently becoming placeholders.
- Then run `npm run render:final` and `npm run stills:final` on an npm-capable machine; output: `out/jinai-memory-final.mp4` and `out/stills-final/{intro,closing}.png`.
- Final output is silent 1920x1080, 30fps H.264; recordings use contain-fit, subtitles start at 0.3s, and only cards fade/rise over 0.4s.
- `final-video.yml` measures, checks, renders, validates MP4 format/frame count/silence, and uploads video/stills for 7 days; do not install or render on the implementation PC.
