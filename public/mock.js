const AUTHORS = ["claude", "chatgpt", "cursor", "copilot"];
const TOPICS = ["Product", "Design", "Engineering", "Everyday", "Graph Hacks"];
const SEEDS = [
  ["A memory should travel", "decision", 0, "Keep useful context in **one shared graph**, not four separate conversations."],
  ["Quiet interfaces, clear words", "preference", 1, "Use calm surfaces, readable text, and a single clear next action.\n\n- Dark background\n- Light that has a meaning\n- Keyboard access"],
  ["Demo story in three moments", "event", 4, "1. Claude saves a thought.\n2. ChatGPT finds that thought.\n3. The connection lights up.\n\n> Make the invisible handoff visible."],
  ["Leave room for curiosity", "fact", 3, "The best questions often connect two things that seemed unrelated."],
  ["Start with the user outcome", "decision", 0, "Before choosing a tool, write down what the person should be able to do."],
  ["Dinner after the demo", "preference", 3, "A warm meal and an unhurried conversation after shipping.\n\nRemember to take a break."],
  ["Connections are context", "fact", 2, "A memory is more useful when its **relationships** are visible, too."],
  ["Readable before spectacular", "decision", 1, "A beautiful graph should still let someone read the actual note.\n\nKeep bloom on the graph, not the interface."],
  ["Keep the modules small", "decision", 2, "Use native ES modules. No build step is needed for this demo.\n\n```js\nconst memory = await readGraph();\n```"],
  ["A constellation, not a dashboard", "preference", 1, "Small points of light, fine connections, and space to breathe."],
  ["Follow the shared idea", "fact", 0, "Different AI tools can work on the same idea without making separate copies of its context."],
  ["Rehearse the handoff", "event", 4, "Open a note from a different AI, then watch the neighborhood respond.\n\n**The note stays readable. The graph shows its use.**"],
  ["A good default is reversible", "preference", 2, "Keep the original force layout available after grouping by AI."],
  ["One more walk before shipping", "event", 3, "Step away for ten minutes. Come back and read the interface as a new visitor."],
  ["Show the author in words", "decision", 1, "Color helps, but a source label must still say **Claude**, **ChatGPT**, **Cursor**, or **Copilot**."],
  ["Ready for Graph Hacks", "event", 4, "Check the story from beginning to end:\n\n- Save\n- Recall across tools\n- Read the memory\n- Follow a connection"],
];

function memoryNode(index, label, kind, topic, text) {
  return {
    id: `memory-${index + 1}`,
    type: "memory",
    label,
    kind,
    source: AUTHORS[Math.floor(index / 4) % AUTHORS.length],
    summary: "Sample memory for the live constellation.",
    text: `# ${label}\n\n${text}`,
    tags: [TOPICS[topic], "demo"],
    createdAt: new Date(Date.UTC(2026, 9, 16, 9, index * 7)).toISOString(),
    occurredAt: kind === "event" ? new Date(Date.UTC(2026, 9, 17, 3)).toISOString() : null,
  };
}

export function createMockSource() {
  const nodes = [
    ...SEEDS.map(([label, kind, topic, text], index) => memoryNode(index, label, kind, topic, text)),
    ...TOPICS.map((label, index) => ({
      id: `topic-${index}`, type: "topic", label, kind: null, source: null,
      summary: "A shared topic", text: "", tags: [], createdAt: null, occurredAt: null,
    })),
    ...AUTHORS.map((source) => ({
      id: `source-${source}`, type: "source", label: source, kind: null, source,
      summary: "An AI tool writing into the shared graph", text: "", tags: [], createdAt: null, occurredAt: null,
    })),
  ];
  const links = [];
  for (let index = 0; index < SEEDS.length; index++) {
    const memory = nodes[index];
    links.push(
      { source: memory.id, target: `topic-${SEEDS[index][2]}`, type: "ABOUT", w: 1 },
      { source: memory.id, target: `source-${memory.source}`, type: "MENTIONED_BY", w: 1 },
      { source: memory.id, target: `memory-${(index + 4) % SEEDS.length + 1}`, type: index % 2 ? "SIMILAR" : "RELATES_TO", w: 0.7 },
    );
  }
  links.push({ source: "memory-3", target: "memory-16", type: "NEXT_STEP", w: 0.9 });
  let sequence = 0;
  let memoryCount = SEEDS.length;
  return {
    async readGraph() {
      return structuredClone({ user: "demo", generatedAt: new Date().toISOString(), nodes, links });
    },
    subscribe(onEvent) {
      const timer = setInterval(() => {
        const memories = nodes.filter((node) => node.type === "memory");
        const picked = memories[Math.floor(Math.random() * memories.length)];
        const op = ["recall", "open", "remember", "orient"][sequence++ % 4];
        let nodeIds = [picked.id, `topic-${SEEDS[(Number(picked.id.split("-")[1]) - 1) % SEEDS.length][2]}`];
        const source = AUTHORS[Math.floor(Math.random() * AUTHORS.length)];
        if (op === "remember" && memoryCount < 20) {
          const added = memoryNode(memoryCount++, `A new connection ${memoryCount - 16}`, "fact", 4,
            `**${source}** just added this memory.\n\nIt connects to [the jsDelivr package](https://cdn.jsdelivr.net/npm/three@0.160.0/package.json) and to a thought already in the graph.`);
          added.source = source;
          added.createdAt = new Date().toISOString();
          nodes.push(added);
          links.push(
            { source: added.id, target: picked.id, type: "RELATES_TO", w: 1 },
            { source: added.id, target: "topic-4", type: "ABOUT", w: 1 },
            { source: added.id, target: `source-${source}`, type: "MENTIONED_BY", w: 1 },
          );
          nodeIds = [added.id, picked.id, "topic-4", `source-${source}`];
        }
        onEvent({ user: "demo", op, source, nodeIds, at: new Date().toISOString() });
      }, 3000);
      return () => clearInterval(timer);
    },
  };
}
