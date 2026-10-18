import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { COLORS, FONT } from "./common.jsx";
import { Conversation, FalkorDBScene, GraphScene, Intro, Outro } from "./scenes.jsx";
import { buildTimeline, FPS } from "./timeline.mjs";

export function Demo({ clips = {} }) {
  const timeline = buildTimeline(clips);
  const scenes = {
    intro: (duration) => <Intro duration={duration} />,
    chatgpt: (duration) => (
      <Conversation
        duration={duration}
        assistant="ChatGPT"
        image="chatgpt-saves-dinner.png"
        heading="Tell it once."
        quote="Tonight I made hamburger steak with demi-glace sauce. It was delicious. I've always liked hamburger steak."
        facts={[
          { label: "PREFERENCE", text: "I've always liked hamburger steak." },
          { label: "DATED EVENT / OCT 17, 2026", text: "Made demi-glace hamburger steak for dinner." },
        ]}
        captions={[
          { from: 0, seconds: 12.5, lines: [
            "I tell ChatGPT about dinner. I never say 'save this'.",
          ] },
          { from: 12.5, seconds: 12.5, lines: [
            "It decides to remember a preference and a dated event.",
          ] },
        ]}
      />
    ),
    write: (duration) => (
      <GraphScene
        duration={duration}
        clip={clips.write}
        title="ChatGPT writes two dinner memories"
        captions={[{ from: 0, seconds: duration / FPS, lines: [
          "Two memories land in the shared 2D graph. FalkorDB is the persistent backend.",
          "Teal = written by ChatGPT.",
        ] }]}
      />
    ),
    claude: (duration) => (
      <Conversation
        duration={duration}
        assistant="Claude"
        image="claude-answers-dinner.png"
        heading="A different AI. The same memory."
        quote="What do you think I should have for dinner tomorrow?"
        facts={[
          { label: "NO REQUEST TO CHECK MEMORY", text: "Claude calls 'Refresh the Memory map'." },
          { label: "CLAUDE'S ANSWER / TRANSLATED", text: "'You just made demi-glace hamburger yesterday (the 17th)...'" },
        ]}
        captions={[
          { from: 0, seconds: 15, lines: [
            "The next day, I ask Claude - a different company's AI -",
            "what to have for dinner tomorrow.",
          ] },
          { from: 15, seconds: 15, lines: [
            "It checks the shared memory on its own:",
            "'You just had demi-glace hamburger yesterday...'",
          ] },
        ]}
      />
    ),
    read: (duration) => (
      <GraphScene
        duration={duration}
        clip={clips.read}
        title="Claude opens ChatGPT's dinner memories"
        read
        requireVerifiedState
        captions={[{ from: 0, seconds: duration / FPS, lines: [
          "You can see which memory it opened - written by ChatGPT, the day before.",
          "Amber particles = Claude reading. Teal nodes = ChatGPT's memories.",
        ] }]}
      />
    ),
    group: (duration) => (
      <GraphScene
        duration={duration}
        clip={clips.group}
        title="Group by AI in 2D"
        requireVerifiedState
        captions={[{ from: 0, seconds: duration / FPS, lines: [
          "Group by AI: four authors, four clusters, one shared 2D graph.",
        ] }]}
      />
    ),
    "ui-3d": (duration) => (
      <GraphScene
        duration={duration}
        clip={clips["ui-3d"]}
        title="The same graph in 3D"
        captions={[{ from: 0, seconds: duration / FPS, lines: [
          "Same graph, also in 3D.",
        ] }]}
      />
    ),
    falkordb: (duration) => <FalkorDBScene duration={duration} />,
    outro: (duration) => <Outro duration={duration} />,
  };
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.background, color: COLORS.white, fontFamily: FONT }}>
      {timeline.scenes.map(({ id, startFrame, durationInFrames }) => (
        <Sequence key={id} name={id} from={startFrame} durationInFrames={durationInFrames}>
          {scenes[id](durationInFrames)}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
