import React from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import { FPS } from "./timeline.mjs";

export const COLORS = {
  background: "#05060a",
  white: "#f4f7fc",
  muted: "#a5afc1",
  teal: "#3ee0c8",
  amber: "#ffb454",
};

export const FONT = "Arial, Helvetica, sans-serif";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };

export const fade = (frame, duration) =>
  interpolate(frame, [0, 14, duration - 15, duration - 1], [0, 1, 1, 0], clamp);

export function Scene({ children, duration }) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.background,
        color: COLORS.white,
        fontFamily: FONT,
      }}
    >
      <AbsoluteFill style={{ opacity: fade(frame, duration) }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
}

export function Eyebrow({ children, color = COLORS.teal, style }) {
  return (
    <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: 4, color, ...style }}>
      {children}
    </div>
  );
}

function Caption({ lines, duration }) {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        bottom: 52,
        left: 70,
        right: 70,
        padding: "20px 30px",
        backgroundColor: "rgba(0, 0, 0, 0.94)",
        borderTop: `1px solid ${COLORS.teal}55`,
        opacity: fade(frame, duration),
        textAlign: "center",
        fontSize: 35,
        lineHeight: 1.35,
        fontWeight: 500,
      }}
    >
      {lines.map((line) => <div key={line}>{line}</div>)}
    </div>
  );
}

export function Captions({ items }) {
  return items.map(({ from, seconds, lines }) => (
    <Sequence key={from} from={from * FPS} durationInFrames={seconds * FPS}>
      <Caption lines={lines} duration={seconds * FPS} />
    </Sequence>
  ));
}
