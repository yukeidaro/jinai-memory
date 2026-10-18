import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import {
  CAPTIONS, COPY, ENGINE_ROWS, IMPORT_ROWS, WRITE_ROWS,
  frameState, progress,
} from "./timeline.mjs";
import {
  COLORS, MONO, SANS, Cascade, Chip, ChipCycle, DimFocus, Dock,
  MiniGraph, Stage, Typing, Window, springAt,
} from "./kit.jsx";

function Terminal({ frame }) {
  const state = frameState(frame);
  return (
    <div style={{ position: "absolute", left: 36, top: 30, width: 572 }}>
      <DimFocus frame={frame}>
        <div style={{ fontSize: 28, color: COLORS.muted, marginBottom: 22 }}>
          {frame < 158 ? "Dry run by default. Review, then import." : "Importing your existing AI memory"}
        </div>
        <div style={{ fontFamily: MONO, minHeight: 88, fontSize: 28, lineHeight: 1.6 }}>
          <span style={{ color: COLORS.amber, marginRight: 12 }}>$</span>
          <Typing frame={frame} from={22} text={COPY.command} cursorUntil={150} />
          {frame >= 150 && <Typing frame={frame} from={150} text={COPY.confirm} cursorUntil={158} />}
          {frame >= 158 && (
            <span style={{
              display: "inline-block", color: COLORS.amber, marginLeft: 12,
              transform: `translateY(${(1 - state.enter) * -8}px) scale(${0.75 + state.enter * 0.25})`,
            }}>{"\u21b5"}</span>
          )}
        </div>
        <Cascade frame={frame} from={60} rows={IMPORT_ROWS} style={{ gap: 19, fontFamily: MONO }} />
        {frame >= 60 && frame < 170 && (
          <div style={{ marginTop: 24, width: 570, height: 3, background: "#E6E8EE12", overflow: "hidden" }}>
            <div style={{ width: `${Math.max(1, state.scan * 100)}%`, height: 3, background: COLORS.amber }} />
          </div>
        )}
        {frame >= 170 && (
          <div style={{ marginTop: 27, fontSize: 28, color: COLORS.amber, fontFamily: MONO }}>
            {frame < 300 ? "Connecting related memories..." : "Imported into Jin AI Memory."}
          </div>
        )}
      </DimFocus>
    </div>
  );
}

function Bubble({ frame, from, text, color }) {
  return (
    <div style={{
      padding: "20px 24px", border: `1px solid ${color}55`, background: `${color}0D`,
      borderRadius: "16px 16px 4px 16px", minHeight: 110,
      boxSizing: "border-box", fontSize: 28, lineHeight: 1.55,
    }}>
      <Typing frame={frame} from={from} text={text} cursorUntil={from + 68} />
    </div>
  );
}

function ChatGPT({ frame }) {
  return (
    <div style={{ position: "absolute", left: 36, top: 30, width: 572 }}>
      <div style={{ fontSize: 28, color: COLORS.muted, marginBottom: 14 }}>You</div>
      <Bubble frame={frame} from={372} text={COPY.prompt} color={COLORS.teal} />
      {frame >= 440 && (
        <div style={{
          marginTop: 38, transform: `translateY(${(1 - springAt(frame, 440, 15)) * 20}px)`,
        }}>
          <div style={{ fontSize: 28, color: COLORS.teal, marginBottom: 14, fontWeight: 650 }}>ChatGPT</div>
          <div style={{ fontSize: 30, lineHeight: 1.5, marginBottom: 24 }}>{COPY.acknowledgment}</div>
          <Cascade
            frame={frame} rows={WRITE_ROWS} color={COLORS.teal}
            style={{ gap: 23 }}
            rowStyle={{
              alignItems: "flex-start", padding: "14px 0",
              borderBottom: "1px solid #2BB3A330", flexWrap: "wrap",
            }}
          />
        </div>
      )}
    </div>
  );
}

function Claude({ frame }) {
  const state = frameState(frame);
  const beforeLength = COPY.answerBefore.length;
  const emphasisLength = COPY.answerEmphasis.length;
  const before = COPY.answerBefore.slice(0, state.answer);
  const emphasis = COPY.answerEmphasis.slice(0, Math.max(0, state.answer - beforeLength));
  const after = COPY.answerAfter.slice(0, Math.max(0, state.answer - beforeLength - emphasisLength));
  return (
    <div style={{ position: "absolute", left: 36, top: 30, width: 572 }}>
      <div style={{ fontSize: 28, color: COLORS.muted, marginBottom: 14 }}>You</div>
      <Bubble frame={frame} from={740} text={COPY.question} color={COLORS.amber} />
      {frame >= 800 && (
        <div style={{
          marginTop: 24, transform: `scaleX(${progress(frame, 800, 8)})`, transformOrigin: "0 50%",
        }}>
          <Chip color={COLORS.amber}>Jin AI Memory &middot; open map</Chip>
        </div>
      )}
      {frame >= 840 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 28, color: COLORS.amber, marginBottom: 14, fontWeight: 650 }}>Claude</div>
          <div style={{ fontSize: 32, lineHeight: 1.65 }}>
            {before}
            {emphasis && <Chip style={{ padding: "0 8px", fontSize: 32 }}>{emphasis}</Chip>}
            {after}
            {frame < 950 && (
              <span style={{
                display: "inline-block", width: 15, height: 30, marginLeft: 4,
                background: COLORS.amber, opacity: state.cursor, verticalAlign: "-4px",
              }} />
            )}
          </div>
        </div>
      )}
      {frame >= 1000 && (
        <div style={{ marginTop: 28, fontSize: 28, lineHeight: 1.6 }}>
          <div style={{ color: COLORS.muted, marginBottom: 8 }}>same memory, read by</div>
          <ChipCycle
            frame={frame}
            items={[{ from: 985, text: "Claude" }, { from: 1036, text: "and any MCP client" }]}
          />
        </div>
      )}
    </div>
  );
}

function Captions({ frame }) {
  const caption = CAPTIONS.find((item) => frame >= item.from && frame < item.to);
  if (!caption) return null;
  return (
    <div style={{
      position: "absolute", top: caption.lines.length > 1 ? 866 : 886,
      left: 70, width: 1780, textAlign: "center",
      fontSize: 40, fontWeight: 550, lineHeight: 1.18, color: COLORS.white,
      textShadow: `0 2px 20px ${COLORS.background}`,
    }}>
      {caption.lines.map((line) => <div key={line}>{line}</div>)}
    </div>
  );
}

function Engine({ frame }) {
  if (frame < 1140 || frame >= 1470) return null;
  const { collapse } = frameState(frame);
  return (
    <AbsoluteFill style={{
      transform: `scale(${1 - collapse})`, transformOrigin: "960px 600px",
    }}>
      <div style={{ position: "absolute", left: 760, top: 200, width: 980 }}>
        <div style={{ fontSize: 42, fontWeight: 700, marginBottom: 26 }}>Powered by FalkorDB</div>
        <Cascade
          frame={frame} rows={ENGINE_ROWS} color={COLORS.teal}
          style={{ gap: 18 }}
          rowStyle={{
            fontSize: 30, padding: "19px 23px", minHeight: 95,
            boxSizing: "border-box", borderRadius: 14,
            background: COLORS.window, border: "1px solid #E6E8EE20",
          }}
        />
      </div>
      <div style={{
        position: "absolute", left: 166, top: 734, width: 1588,
        borderTop: "1px solid #E6E8EE20", paddingTop: 20,
        color: COLORS.teal, fontFamily: MONO, fontSize: 28, lineHeight: 1.5,
        whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      }}>
        {COPY.query.replace(" YIELD", "\nYIELD")}
      </div>
    </AbsoluteFill>
  );
}

function Closing({ frame }) {
  if (frame < 1480) return null;
  const state = frameState(frame);
  return (
    <AbsoluteFill style={{ textAlign: "center", pointerEvents: "none" }}>
      <div style={{
        position: "absolute", left: 200, right: 200,
        top: 458 + (1 - state.brand) * 18,
        fontSize: 64, fontWeight: 750, letterSpacing: 12 * (1 - state.brand) - 1.5,
      }}>Jin AI Memory</div>
      {frame >= 1540 && (
        <div style={{
          position: "absolute", top: 350 + (1 - state.tagline) * 20,
          left: 180, right: 180, fontSize: 40, fontWeight: 500,
          color: COLORS.text,
        }}>One memory. Every AI. And you can see it.</div>
      )}
    </AbsoluteFill>
  );
}

export function JinAIMemoryDemo() {
  const frame = useCurrentFrame();
  const state = frameState(frame);
  const page = frame < 366 ? "terminal" : frame < 726 ? "chatgpt" : "claude";
  const highlight = frame >= 800 ? ["burgers", "dinner"]
    : frame >= 505 ? ["burgers", "dinner"] : frame >= 470 ? ["burgers"] : [];
  return (
    <Stage
      frame={frame}
      overlay={<><Captions frame={frame} /><Dock frame={frame} /><Closing frame={frame} /></>}
    >
      <div style={{
        position: "absolute", left: 145, top: 44, fontFamily: SANS,
        fontSize: 28, letterSpacing: 1.5, fontWeight: 650,
        transform: `scale(${1 - state.collapse})`, transformOrigin: "0 50%",
      }}>Jin AI Memory</div>
      <div style={{
        position: "absolute", right: 145, top: 44, fontSize: 28, color: COLORS.muted,
        transform: `scale(${1 - state.collapse})`, transformOrigin: "100% 50%",
      }}>Illustrated demo</div>
      <Window frame={frame}>
        {page === "terminal" ? <Terminal frame={frame} />
          : page === "chatgpt" ? <ChatGPT frame={frame} /> : <Claude frame={frame} />}
      </Window>
      <MiniGraph
        frame={frame} highlight={highlight}
        travel={frame >= 800 && frame < 1110 ? ["import-24", "burgers"] : null}
      />
      {frame >= 170 && frame < 1110 && (
        <div style={{
          position: "absolute", left: 1200, top: 210,
          transform: `scale(${1 - state.minimize})`, transformOrigin: "50% 50%",
        }}>
          <Chip color={frame < 366 || frame >= 726 ? COLORS.amber : COLORS.teal}>
            {frame < 366 ? `${frame < 300 ? Math.round(state.import * 114) : 114} memories` : "Shared memory"}
          </Chip>
        </div>
      )}
      <Engine frame={frame} />
    </Stage>
  );
}
