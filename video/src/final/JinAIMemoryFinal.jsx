import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { COLORS, MONO, SANS } from "../teaser/kit.jsx";
import { buildFinalTimeline, CAPTION_FROM, FADE_FRAMES } from "./timeline.mjs";

const ACCENT = "#a84a1c";
const clamp = (value) => Math.max(0, Math.min(1, value));

export async function calculateFinalMetadata({ props }) {
  const response = await fetch(staticFile("final/durations.json"));
  if (!response.ok) {
    throw new Error(`Cannot load final/durations.json (HTTP ${response.status}).`);
  }
  const durations = await response.json();
  return {
    durationInFrames: buildFinalTimeline(durations).durationInFrames,
    props: { ...props, durations },
  };
}

function Card({ durationInFrames, children }) {
  const frame = useCurrentFrame();
  const enter = clamp(frame / FADE_FRAMES);
  const exit = clamp((durationInFrames - 1 - frame) / FADE_FRAMES);
  return (
    <AbsoluteFill style={{
      justifyContent: "center", alignItems: "center", textAlign: "center",
      opacity: Math.min(enter, exit),
      transform: `translateY(${(1 - enter) * 16}px)`,
    }}>
      {children}
    </AbsoluteFill>
  );
}

function Intro({ durationInFrames }) {
  return (
    <Card durationInFrames={durationInFrames}>
      <div style={{ fontSize: 32, color: COLORS.muted, marginBottom: 32 }}>Introducing</div>
      <div style={{ fontSize: 112, lineHeight: 1.1, fontWeight: 750, letterSpacing: -3 }}>
        Jin AI Memory
      </div>
      <div style={{ fontSize: 42, marginTop: 38 }}>
        One command. One shared memory for your agents.
      </div>
    </Card>
  );
}

function Closing({ durationInFrames }) {
  return (
    <Card durationInFrames={durationInFrames}>
      <div style={{ fontSize: 34, color: COLORS.muted, marginBottom: 34 }}>
        give your agents one shared memory
      </div>
      <div style={{ fontSize: 112, lineHeight: 1.1, fontWeight: 750, letterSpacing: -3 }}>
        Jin AI Memory
      </div>
      <div style={{
        marginTop: 58, padding: "26px 38px", borderRadius: 20,
        border: `2px solid ${ACCENT}`, fontFamily: MONO, fontSize: 38,
        display: "flex", alignItems: "center", gap: 20,
      }}>
        <span style={{ color: ACCENT }}>{"\u203a"}</span>
        <span>npx github:yukeidaro/jinai-memory init</span>
      </div>
      <div style={{ position: "absolute", bottom: 78, fontSize: 27, color: COLORS.muted }}>
        github.com/yukeidaro/jinai-memory {"\u00b7"} built on FalkorDB
      </div>
    </Card>
  );
}

function Recording({ scene }) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      {scene.pending ? (
        <Card durationInFrames={scene.durationInFrames}>
          <div style={{ fontSize: 46, maxWidth: 1660, lineHeight: 1.4 }}>{scene.label}</div>
        </Card>
      ) : (
        <OffthreadVideo
          src={staticFile(`final/${scene.file}`)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      )}
      {frame >= CAPTION_FROM && (
        <div style={{
          position: "absolute", bottom: 50, left: 80, right: 80,
          display: "flex", justifyContent: "center",
        }}>
          <div style={{
            backgroundColor: "rgba(10, 14, 26, 0.85)", color: COLORS.text,
            fontSize: 40, lineHeight: 1.35, fontWeight: 550, textAlign: "center",
            padding: "18px 30px", borderRadius: 12,
          }}>{scene.caption}</div>
        </div>
      )}
    </AbsoluteFill>
  );
}

export function JinAIMemoryFinal({ durations }) {
  const timeline = buildFinalTimeline(durations);
  return (
    <AbsoluteFill style={{
      backgroundColor: COLORS.background, color: COLORS.text, fontFamily: SANS,
    }}>
      {timeline.scenes.map((scene) => (
        <Sequence
          key={scene.id} name={scene.id} from={scene.startFrame}
          durationInFrames={scene.durationInFrames}
        >
          {scene.id === "intro" ? <Intro durationInFrames={scene.durationInFrames} />
            : scene.id === "closing" ? <Closing durationInFrames={scene.durationInFrames} />
              : <Recording scene={scene} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
