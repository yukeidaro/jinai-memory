import React from "react";
import { AbsoluteFill, Img, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Captions, COLORS, Eyebrow, Scene } from "./common.jsx";
import { CYPHER, FPS, frameAtTime } from "./timeline.mjs";

export function Intro({ duration }) {
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 140 }}>
        <Eyebrow>SHARED MEMORY / VISIBLE CONTEXT</Eyebrow>
        <h1 style={{ fontSize: 116, letterSpacing: -5, margin: "35px 0" }}>
          Jin AI <span style={{ color: COLORS.teal }}>Memory</span>
        </h1>
        <div style={{ fontSize: 43, lineHeight: 1.5, textAlign: "center", maxWidth: 1500 }}>
          One memory graph for every AI you use
          <br />
          and you can see what it uses.
        </div>
        <div style={{ marginTop: 65, fontSize: 25, color: COLORS.muted }}>
          ChatGPT saves. Claude reads. The graph shows the connection.
        </div>
      </AbsoluteFill>
    </Scene>
  );
}

export function Conversation({ duration, assistant, image, heading, quote, facts, captions }) {
  const frame = useCurrentFrame();
  const color = assistant === "ChatGPT" ? COLORS.teal : COLORS.amber;
  const scale = interpolate(frame, [0, duration - 1], [1, 1.035], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <Scene duration={duration}>
      <div style={{ position: "absolute", left: 90, top: 110, width: 820 }}>
        <Eyebrow color={color}>ACTUAL {assistant.toUpperCase()} CONVERSATION</Eyebrow>
        <h2 style={{ fontSize: 67, letterSpacing: -2, lineHeight: 1.12, margin: "35px 0" }}>
          {heading}
        </h2>
        <div style={{ color: COLORS.muted, fontSize: 22, marginBottom: 18 }}>
          English translation of the supplied Japanese screenshot
        </div>
        <div style={{ fontSize: 37, lineHeight: 1.45, borderLeft: `4px solid ${color}`, paddingLeft: 28 }}>
          {quote}
        </div>
        <div style={{ marginTop: 45, display: "grid", gap: 18 }}>
          {facts.map(({ label, text }) => (
            <div key={label} style={{ fontSize: 28, lineHeight: 1.4 }}>
              <span style={{ color, fontWeight: 700 }}>{label}</span>
              <div style={{ marginTop: 5 }}>{text}</div>
            </div>
          ))}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 50,
          right: 65,
          width: 885,
          height: 825,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          border: `1px solid ${color}55`,
          borderRadius: 24,
          backgroundColor: "#000",
          overflow: "hidden",
        }}
      >
        <Img
          src={staticFile(image)}
          style={{ width: 790, height: 780, objectFit: "contain", transform: `scale(${scale})` }}
        />
      </div>
      <Captions items={captions} />
    </Scene>
  );
}

export function GraphScene({ duration, clip, title, captions, read = false }) {
  const frame = useCurrentFrame();
  const image = clip ? frameAtTime(clip.frames, frame / FPS) : null;
  return (
    <Scene duration={duration}>
      {clip ? (
        <Img
          src={staticFile(`${clip.directory}/${image.file}`)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        <AbsoluteFill style={{ backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}>
          <Eyebrow color={COLORS.amber}>RECORDING UNAVAILABLE</Eyebrow>
          <div style={{ marginTop: 30, fontSize: 38 }}>
            {title}
          </div>
          <div style={{ marginTop: 25, fontSize: 27, color: COLORS.muted }}>
            No UI footage was captured. This is not a simulated graph.
          </div>
        </AbsoluteFill>
      )}
      <div
        style={{
          position: "absolute",
          top: 130,
          left: 350,
          right: 460,
          padding: "12px 18px",
          backgroundColor: "rgba(0, 0, 0, 0.9)",
          color: COLORS.muted,
          fontSize: 18,
          lineHeight: 1.4,
          textAlign: "center",
        }}
      >
        Scripted MCP replay / fictional demo notes
        <br />
        Local in-memory store / fake embeddings
      </div>
      {read ? (
        <div style={{ position: "absolute", left: 350, right: 460, bottom: 185, fontSize: 18, color: COLORS.muted, backgroundColor: "#000d", padding: 12 }}>
          Highlights record server-side memory access, not proof of model reasoning.
        </div>
      ) : null}
      <Captions items={captions} graph />
    </Scene>
  );
}

function QueryCard({ query }) {
  return (
    <div style={{ position: "absolute", top: 285, left: 95, right: 95 }}>
      <Eyebrow>{query.title}</Eyebrow>
      <div style={{ marginTop: 20, fontSize: 35 }}>{query.explanation}</div>
      <pre
        style={{
          fontFamily: '"DejaVu Sans Mono", Consolas, monospace',
          fontSize: 27,
          lineHeight: 1.7,
          marginTop: 35,
          padding: "35px 30px",
          backgroundColor: "#10151e",
          color: COLORS.teal,
          border: "1px solid #28313f",
          borderRadius: 14,
          whiteSpace: "pre-wrap",
        }}
      >
        {query.code}
      </pre>
      <div style={{ fontSize: 23, color: COLORS.muted }}>
        Actual Cypher from README.md and src/store/falkordb-store.js
      </div>
    </div>
  );
}

export function FalkorDBScene({ duration }) {
  return (
    <Scene duration={duration}>
      <div style={{ position: "absolute", top: 85, left: 95, right: 95 }}>
        <Eyebrow>THE PERSISTENT MEMORY ENGINE</Eyebrow>
        <h2 style={{ fontSize: 70, margin: "22px 0" }}>
          <span style={{ color: COLORS.teal }}>FalkorDB</span> is the whole memory.
        </h2>
        <div style={{ fontSize: 28, color: COLORS.muted }}>
          Notes + vector index + relationships, in memory:&lt;user&gt;
        </div>
      </div>
      {CYPHER.map((query, index) => (
        <Sequence key={query.title} from={index * 10 * FPS} durationInFrames={10 * FPS}>
          <QueryCard query={query} />
        </Sequence>
      ))}
      <div style={{ position: "absolute", bottom: 235, left: 95, right: 95, fontSize: 23, color: COLORS.muted }}>
        2,000-note check: in-memory response size, not database latency.
        <br />
        Token counts are estimates; isolation is per-user graph namespacing.
      </div>
      <Captions
        items={[
          { from: 0, seconds: 20, lines: [
            "FalkorDB is the whole memory: a vector index wires related notes on write.",
            "Graph traversal follows the edges on read.",
          ] },
          { from: 20, seconds: 10, lines: [
            "The entry map stays within 400 estimated tokens, even at 2,000 notes.",
            "Each user gets an isolated graph.",
          ] },
        ]}
      />
    </Scene>
  );
}

export function Outro({ duration }) {
  return (
    <Scene duration={duration}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <Eyebrow>JIN AI MEMORY</Eyebrow>
        <h2 style={{ fontSize: 91, lineHeight: 1.25, letterSpacing: -3, margin: "40px 0" }}>
          One memory. Every AI.
          <br />
          <span style={{ color: COLORS.teal }}>And you can see it.</span>
        </h2>
        <div style={{ fontSize: 37, marginTop: 30 }}>github.com/yukeidaro/jinai-memory</div>
        <div style={{ fontSize: 28, color: COLORS.muted, marginTop: 55 }}>
          Built for Graph Hacks (WeMakeDevs x FalkorDB)
        </div>
      </AbsoluteFill>
    </Scene>
  );
}
