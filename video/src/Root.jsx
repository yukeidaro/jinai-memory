import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo.jsx";
import { JinAIMemoryDemo } from "./teaser/JinAIMemoryDemo.jsx";
import { calculateFinalMetadata, JinAIMemoryFinal } from "./final/JinAIMemoryFinal.jsx";
import {
  buildFinalTimeline, EMPTY_DURATIONS, FPS as FINAL_FPS, HEIGHT as FINAL_HEIGHT,
  WIDTH as FINAL_WIDTH,
} from "./final/timeline.mjs";
import { buildTimeline, DURATION, FPS, HEIGHT, WIDTH } from "./timeline.mjs";

export const RemotionRoot = () => (
  <>
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
    <Composition
      id="JinAIMemoryDemo"
      component={JinAIMemoryDemo}
      durationInFrames={1650}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="JinAIMemoryFinal"
      component={JinAIMemoryFinal}
      durationInFrames={buildFinalTimeline(EMPTY_DURATIONS).durationInFrames}
      fps={FINAL_FPS}
      width={FINAL_WIDTH}
      height={FINAL_HEIGHT}
      defaultProps={{ durations: EMPTY_DURATIONS }}
      calculateMetadata={calculateFinalMetadata}
    />
  </>
);
