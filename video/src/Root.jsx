import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo.jsx";
import { DURATION, FPS, HEIGHT, WIDTH } from "./timeline.mjs";

export const RemotionRoot = () => (
  <Composition
    id="Demo"
    component={Demo}
    durationInFrames={DURATION}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
    defaultProps={{ clips: {} }}
  />
);
