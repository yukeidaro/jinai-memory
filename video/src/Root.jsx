import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo.jsx";
import { buildTimeline, DURATION, FPS, HEIGHT, WIDTH } from "./timeline.mjs";

export const RemotionRoot = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={DURATION}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={{ clips: {} }}
    calculateMetadata={({ props }) => ({
      durationInFrames: buildTimeline(props.clips).durationInFrames,
    })}
  />
);
