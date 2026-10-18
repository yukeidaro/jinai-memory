import React from "react";
import { AbsoluteFill, Easing, interpolate, spring } from "remotion";
import {
  COPY, FPS, HOLD_FROM, REPOSITORY_CHARS_PER_FRAME, REPOSITORY_FROM, WINDOW_HEIGHT,
  clamp01, frameState, graphLabelsAt, mix, progress, repeatDuration, typedText,
} from "./timeline.mjs";

export const COLORS = {
  background: "#0A0E1A",
  window: "#1C2030",
  text: "#E6E8EE",
  muted: "#9CA5BA",
  teal: "#2BB3A3",
  amber: "#E3A33B",
  white: "#FFFFFF",
};
export const SANS = "Inter, system-ui, sans-serif";
export const MONO = "ui-monospace, Menlo, monospace";
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
const AI = {
  jin: { letter: "J", title: "Jin AI Memory", color: COLORS.white },
  terminal: { letter: "CC", title: "Terminal", color: COLORS.amber },
  chatgpt: { letter: "G", title: "ChatGPT", color: COLORS.teal },
  claude: { letter: "C", title: "Claude", color: COLORS.amber },
};
const DOCK_X = [846, 922, 998, 1074];
const DOCK_Y = 1010;

export function springAt(frame, from, duration = 15) {
  if (frame <= from) return 0;
  if (frame >= from + duration) return 1;
  return spring({
    frame: frame - from,
    fps: FPS,
    durationInFrames: duration,
    config: { damping: 18, stiffness: 180 },
  });
}

export function Starfield({ frame }) {
  const live = Math.min(frame, HOLD_FROM);
  return (
    <AbsoluteFill style={{ opacity: 0.4, overflow: "hidden" }}>
      <svg width="1920" height="1080" style={{ position: "absolute" }}>
        {Array.from({ length: 190 }, (_, index) => {
          const x = ((index * 137.51 + live * 0.12) % 1980) - 30;
          const y = ((index * 223.19 + live * 0.045) % 1140) - 30;
          return (
            <rect
              key={index} x={x} y={y} width={index % 5 === 0 ? 2 : 1}
              height={index % 5 === 0 ? 2 : 1} fill={COLORS.text}
              opacity={0.35 + (index % 4) * 0.2}
            />
          );
        })}
      </svg>
    </AbsoluteFill>
  );
}

export function PunchIn({ frame, from = 236, children }) {
  const scale = interpolate(
    frame, [from, from + 6, from + 15, from + 31], [1, 1.25, 0.92, 1],
    { ...CLAMP, easing: Easing.inOut(Easing.cubic) },
  );
  return <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "65% 45%" }}>{children}</AbsoluteFill>;
}

export function Stage({ frame, children, overlay }) {
  const { camera } = frameState(frame);
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.background, color: COLORS.text, fontFamily: SANS, overflow: "hidden" }}>
      <Starfield frame={frame} />
      <AbsoluteFill style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
        <PunchIn frame={frame}>{children}</PunchIn>
        {overlay}
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

export function Magnify({ amount, children }) {
  return (
    <div style={{ transform: `translateY(${-8 * amount}px) scale(${1 + 0.5 * amount})`, transformOrigin: "50% 100%" }}>
      {children}
    </div>
  );
}

export function DockCollapse({ frame, index, children }) {
  const collapse = frameState(frame).collapse;
  const disappear = index === 0 ? 0 : progress(frame, 1440 + (3 - index) * 3, 3);
  return (
    <div style={{
      position: "absolute",
      left: mix(DOCK_X[index], 960, collapse),
      top: mix(DOCK_Y, 600, collapse),
      transform: `translate(-50%, -50%) scale(${1 - disappear})`,
    }}>
      {children}
    </div>
  );
}

export function Morph({ frame, baseSize = 64 }) {
  const amount = clamp01(springAt(frame, 1470, 10));
  const width = mix(baseSize, 520, amount);
  const height = mix(baseSize, 56, amount);
  return (
    <div style={{
      width, height, borderRadius: mix(16, 12, amount),
      background: COLORS.white, color: COLORS.background,
      boxShadow: `0 0 ${mix(0, 60, amount)}px #FFFFFF12`,
      display: "flex", alignItems: "center", overflow: "hidden",
      fontFamily: MONO, whiteSpace: "nowrap",
    }}>
      <span style={{
        display: "inline-flex", justifyContent: "center", alignItems: "center",
        width: mix(baseSize, 48, amount), flexShrink: 0,
        fontFamily: SANS, fontSize: mix(30, 25, amount), fontWeight: 800,
      }}>J</span>
      {frame >= 1480 && (
        <Typing
          frame={frame} from={REPOSITORY_FROM} text={COPY.repository}
          charsPerFrame={REPOSITORY_CHARS_PER_FRAME} fontSize={22} cursorUntil={1540}
        />
      )}
    </div>
  );
}

export function Dock({ frame }) {
  const state = frameState(frame);
  const enter = springAt(frame, 0, 12);
  const ids = ["jin", "terminal", "chatgpt", "claude"];
  const active = frame < 360 ? 1 : frame < 720 ? 2 : frame < 1110 ? 3 : 0;
  const activeFrom = [1110, 4, 360, 720][active];
  const magnify = frame < activeFrom + 12
    ? progress(frame, activeFrom, 8)
    : 1 - progress(frame, activeFrom + 12, 9);
  return (
    <AbsoluteFill style={{ transform: `translateY(${(1 - enter) * 30}px)`, pointerEvents: "none" }}>
      {frame < 1470 && (
        <div style={{
          position: "absolute",
          left: 960, top: mix(DOCK_Y, 600, state.collapse),
          width: mix(324, 64, state.collapse), height: mix(88, 64, state.collapse),
          transform: "translate(-50%, -50%)", borderRadius: 24,
          border: `1px solid #E6E8EE1F`, background: COLORS.window,
          boxShadow: "0 18px 70px #00000050",
        }} />
      )}
      {ids.map((id, index) => (
        <DockCollapse key={id} frame={frame} index={index}>
          {index === 0 ? (
            <Morph frame={frame} baseSize={mix(56, 64, state.collapse)} />
          ) : (
            <Magnify amount={index === active ? magnify : 0}>
              <div style={{
                width: 56, height: 56, borderRadius: 14,
                background: AI[id].color, color: COLORS.background,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: id === "terminal" ? 22 : 28, fontWeight: 800,
                boxShadow: index === active ? `0 0 22px ${AI[id].color}35` : "none",
              }}>{AI[id].letter}</div>
            </Magnify>
          )}
        </DockCollapse>
      ))}
    </AbsoluteFill>
  );
}

export function Window({ frame, children }) {
  if (frame < 12 || frame >= 1122) return null;
  const state = frameState(frame);
  const spawn = springAt(frame, 12, 9);
  const minimize = progress(frame, 1110, 12);
  const height = WINDOW_HEIGHT + 100 * progress(frame, 975, 25);
  const id = frame < 366 ? "terminal" : frame < 726 ? "chatgpt" : "claude";
  const identity = AI[id];
  const turn = frame >= 360 && frame < 372 ? state.terminalTurn
    : frame >= 720 && frame < 732 ? state.claudeTurn : 0;
  const fold = Math.max(0.001, Math.abs(1 - 2 * turn));
  const x = mix((DOCK_X[1] - 960) * (1 - spawn), DOCK_X[0] - 960, minimize);
  const y = mix((DOCK_Y - 480) * (1 - spawn), DOCK_Y - 480, minimize);
  return (
    <div style={{
      position: "absolute", left: 320, top: 100, width: 1280, height,
      borderRadius: 16, overflow: "hidden", background: COLORS.window,
      border: "1px solid #E6E8EE24", boxShadow: "0 35px 120px #00000080",
      transform: `translate(${x}px, ${y}px) scale(${spawn * mix(1, 56 / 1280, minimize)}, ${spawn * mix(1, 56 / height, minimize)})`,
    }}>
      <div style={{
        height: 82, display: "flex", alignItems: "center", padding: "0 30px",
        borderBottom: "1px solid #E6E8EE14", gap: 12,
      }}>
        {[COLORS.muted, COLORS.amber, COLORS.teal].map((color) => (
          <div key={color} style={{ width: 12, height: 12, borderRadius: "50%", background: color, opacity: 0.7 }} />
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginLeft: 30, transform: `scaleY(${fold})` }}>
          <span style={{
            width: 40, height: 40, borderRadius: 10, background: identity.color,
            color: COLORS.background, fontSize: 28,
            fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
          }}>{identity.letter}</span>
          <span style={{ fontSize: 28, fontWeight: 650 }}>{identity.title}</span>
        </div>
        <span style={{ marginLeft: "auto", fontSize: 28, color: COLORS.muted }}>connected: Jin AI Memory</span>
      </div>
      <div style={{ position: "absolute", inset: "82px 0 0", transform: `scaleY(${fold})`, transformOrigin: "50% 0" }}>
        {children}
      </div>
    </div>
  );
}

export function Typing({
  frame, from, text, charsPerFrame = 1, fontSize = 28, cursorUntil = Infinity, cursor = true, style,
}) {
  const state = frameState(frame);
  const visible = typedText(state.frame, from, text, charsPerFrame);
  return (
    <span style={{ fontFamily: MONO, fontSize, lineHeight: 1.55, overflowWrap: "anywhere", ...style }}>
      {visible}
      {cursor && frame >= from && frame < cursorUntil && (
        <span style={{
          display: "inline-block", verticalAlign: "-0.12em", marginLeft: 3,
          width: "0.55em", height: "1.05em", background: "currentColor",
          opacity: state.cursor ? 1 : 0,
        }} />
      )}
    </span>
  );
}

export function Cascade({ frame, from = 0, rows, color = COLORS.amber, style, rowStyle, check = true }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, ...style }}>
      {rows.map((row, index) => {
        const start = row.from ?? from + index * 3;
        const amount = springAt(frame, start, repeatDuration(index));
        return (
          <div key={row.label ?? row.text} style={{
            display: row.text ? "flex" : "grid",
            gridTemplateColumns: row.text ? undefined : `minmax(0, 1fr) max-content${check ? " 28px" : ""}`,
            alignItems: "center", gap: 14, minHeight: 40,
            transform: `translateY(${(1 - amount) * 22}px) scaleY(${Math.max(0, amount)})`,
            transformOrigin: "50% 0", fontSize: 28, lineHeight: 1.45,
            ...rowStyle,
          }}>
            {row.text ? <span>{row.text}</span> : (
              <>
                <span style={{ color: COLORS.muted }}>{row.label}</span>
                <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{row.value}</span>
              </>
            )}
            {check && <span style={{ color, marginLeft: row.text ? "auto" : 0, textAlign: "right", fontSize: 28 }}>{"\u2713"}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function Chip({ children, color = COLORS.amber, style }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", padding: "7px 14px",
      borderRadius: 10, color, border: `1px solid ${color}55`,
      background: `${color}14`, fontSize: 28, lineHeight: 1.35, fontWeight: 650,
      ...style,
    }}>{children}</span>
  );
}

export function ChipCycle({ frame, items, color = COLORS.amber }) {
  const index = Math.max(0, items.findLastIndex((item) => frame >= item.from));
  const item = items[index];
  const turn = progress(frame, item.from, repeatDuration(index));
  return (
    <span style={{ display: "inline-block", transform: `translateY(${(1 - turn) * 12}px) scaleY(${turn})`, transformOrigin: "50% 50%" }}>
      <Chip color={color}>{item.text}</Chip>
    </span>
  );
}

export function DimFocus({ frame, from = 300, children }) {
  return <div style={{ opacity: 1 - progress(frame, from, 6) * 0.7 }}>{children}</div>;
}

const GRAPH_NODES = Array.from({ length: 54 }, (_, index) => {
  const angle = index * 2.399963;
  const radius = 45 + Math.sqrt(index / 53) * 172;
  return {
    id: `import-${index}`,
    x: 287 + Math.cos(angle) * radius,
    y: 272 + Math.sin(angle) * radius,
    from: 170 + index * 1.55,
    color: COLORS.amber,
  };
});
const EXTRA_NODES = [
  { id: "burgers", x: 386, y: 208, from: 470, color: COLORS.teal },
  { id: "dinner", x: 345, y: 400, from: 505, color: COLORS.teal },
];
const ALL_NODES = [...GRAPH_NODES, ...EXTRA_NODES];
const GRAPH_EDGES = GRAPH_NODES.slice(1).map((node, index) => ({
  from: GRAPH_NODES[Math.floor(index / 2)].id, to: node.id,
}));
GRAPH_EDGES.push(
  { from: "import-0", to: "burgers" },
  { from: "burgers", to: "dinner" },
  { from: "import-24", to: "dinner" },
);

function graphPoint(node, frame) {
  const arrival = progress(frame, node.from, node.color === COLORS.teal ? 15 : 44);
  const ease = 1 - (1 - arrival) ** 3;
  const drift = frameState(frame).graphDrift;
  return {
    x: mix(40 + (Number(node.id.replace("import-", "")) || 6) % 11 * 48, node.x, ease) + drift * 1.8,
    y: mix(-170 - (node.from % 7) * 13, node.y, ease) + Math.sin(Math.min(frame, HOLD_FROM) / 29 + node.x) * 2,
    arrival,
  };
}

export function MiniGraph({ frame, highlight = [], travel = null }) {
  if (frame < 12 || frame >= 1470) return null;
  const state = frameState(frame);
  const expanded = state.expand;
  const collapse = state.collapse;
  const width = mix(mix(575, 1660, expanded), 1, collapse);
  const height = mix(mix(480, 650, expanded), 1, collapse);
  const left = mix(mix(985, 130, expanded), 960, collapse);
  const top = mix(mix(254, 140, expanded), 600, collapse);
  const points = Object.fromEntries(ALL_NODES.map((node) => [node.id, graphPoint(node, frame)]));
  const viewWidth = mix(600, 1500, expanded);
  const read = state.read;
  const labels = graphLabelsAt(frame);
  return (
    <div style={{ position: "absolute", left, top, width, height, overflow: "hidden", borderRadius: 16 }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${viewWidth} 560`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="teaser-halo">
            <stop offset="0" stopColor={COLORS.amber} stopOpacity="0.13" />
            <stop offset="1" stopColor={COLORS.amber} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="290" cy="275" r="265" fill="url(#teaser-halo)" />
        {frame < 214 && (
          <g opacity={0.2 * (1 - progress(frame, 170, 44))}>
            {GRAPH_NODES.map((node) => (
              <circle key={`preview-${node.id}`} cx={node.x} cy={node.y} r="4.5" fill={COLORS.amber} />
            ))}
          </g>
        )}
        {GRAPH_EDGES.map((edge) => {
          const a = points[edge.from];
          const b = points[edge.to];
          const ready = Math.min(a.arrival, b.arrival);
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={a.x} y1={a.y} x2={mix(a.x, b.x, ready)} y2={mix(a.y, b.y, ready)}
              stroke={edge.to === "burgers" || edge.to === "dinner" ? COLORS.teal : COLORS.amber}
              strokeWidth="1.2" opacity={0.23 * ready}
            />
          );
        })}
        {ALL_NODES.map((node) => {
          const point = points[node.id];
          if (frame < node.from) return null;
          const lit = highlight.includes(node.id);
          const pulse = lit ? 1 + (0.5 + 0.5 * state.graphDrift) * 0.6 : 1;
          return (
            <g key={node.id}>
              <circle cx={point.x} cy={point.y} r={(lit ? 24 : 14) * pulse} fill={node.color} opacity={lit ? 0.15 : 0.06} />
              <circle cx={point.x} cy={point.y} r={node.color === COLORS.teal ? 7 : 4.5} fill={node.color} />
            </g>
          );
        })}
        {travel && frame >= 800 && (() => {
          const a = points[travel[0]];
          const b = points[travel[1]];
          return (
            <g>
              <line x1={a.x} y1={a.y} x2={mix(a.x, b.x, read)} y2={mix(a.y, b.y, read)} stroke={COLORS.amber} strokeWidth="2.5" />
              {frame >= 840 && (
                <circle cx={mix(a.x, b.x, state.photon)} cy={mix(a.y, b.y, state.photon)} r="6" fill={COLORS.white} />
              )}
            </g>
          );
        })()}
        {frame >= 1140 && (
          <g>
            {GRAPH_EDGES.slice(2, 3).map((edge) => {
              const a = points[edge.from];
              const b = points[edge.to];
              return <circle key="engine-photon" cx={mix(a.x, b.x, state.photon)} cy={mix(a.y, b.y, state.photon)} r="6" fill={COLORS.white} />;
            })}
          </g>
        )}
        {labels.map((label) => (
          <g key={`label-${label.id}`}>
            <rect
              x={label.x - 8} y={label.y - 30} width={label.width} height="42" rx="6"
              fill={expanded > 0 ? COLORS.background : COLORS.window}
            />
            <text
              x={label.x} y={label.y} fontSize="28" fontFamily={SANS} fontWeight="600"
              fill={highlight.includes(label.id) ? COLORS.text
                : label.id === "burgers" || label.id === "dinner" ? COLORS.teal : COLORS.amber}
            >{label.text}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
