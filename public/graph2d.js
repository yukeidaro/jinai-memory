const LAYOUT_KEYS = ["x", "y", "z", "vx", "vy", "vz", "fx", "fy", "fz"];

export function captureLayout(nodes) {
  return new Map(nodes.map((node) => [
    node.id,
    Object.fromEntries(LAYOUT_KEYS.filter((key) => Object.hasOwn(node, key)).map((key) => [key, node[key]])),
  ]));
}

export function restoreLayout(nodes, layout, initialize = () => {}) {
  for (const [index, node] of nodes.entries()) {
    for (const key of LAYOUT_KEYS) delete node[key];
    const saved = layout.get(node.id);
    if (saved) Object.assign(node, saved);
    else initialize(node, index);
  }
}

export function pulseStrength(elapsed) {
  return elapsed < 0 ? 0 : elapsed < 200 ? elapsed / 200 : elapsed < 2200 ? (1 - (elapsed - 200) / 2000) ** 2 : 0;
}

export async function createGraph2D(container, {
  author, emphasized, pulses, isSelected, onSelect, onInteract, motionPreference, initialSplit,
}) {
  const [{ default: ForceGraph }, { forceCollide }] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/force-graph@1.52.0/+esm"),
    import("https://cdn.jsdelivr.net/npm/d3-force-3d@3.0.6/+esm"),
  ]);
  let graph;
  let data = { nodes: [], links: [] };
  let layout3d = new Map();
  let layout2d = new Map();
  let split = initialSplit;
  let active = false;
  let fitPending = false;
  let autoFit = true;
  let hoveredId = null;
  const duration = () => motionPreference.matches ? 0 : 700;
  const radius = (node) => node.type === "source" ? 6 : node.type === "topic" ? 2 : 4;
  const endpoint = (value) => typeof value === "object" ? value : data.nodes.find((node) => node.id === value);

  function fit(padding = 110) {
    fitPending = false;
    graph.zoomToFit(duration(), Math.min(padding, graph.width() / 4, graph.height() / 4));
    // A tiny graph should not turn a single memory into a screen-sized dot.
    if (data.nodes.length < 2) graph.zoom(1.8, duration());
  }

  function clusterForce(alpha) {
    if (!split) return;
    for (const node of data.nodes) {
      const center = node.type === "topic" ? [0, 0] : author(node).center;
      const strength = node.type === "topic" ? 0.035 : 0.16;
      node.vx += (center[0] * 1.8 - node.x) * alpha * strength;
      node.vy += (center[1] * 1.8 - node.y) * alpha * strength;
    }
  }

  function cancelAutoFit() {
    autoFit = fitPending = false;
    onInteract();
  }

  function drawNode(node, context, scale) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    const elapsed = performance.now() - (pulses.get(node.id) ?? -Infinity);
    const pulse = pulseStrength(elapsed);
    if (elapsed >= 2200) pulses.delete(node.id);
    const focus = hoveredId === node.id || isSelected(node) ? 0.65 : 0;
    const size = radius(node) * (1 + pulse * 0.65 + focus * 0.2);
    const color = node.type === "topic" ? "#c8d7ed" : author(node).color;
    context.save();
    context.globalAlpha = emphasized(node) ? 1 : 0.09;
    context.shadowColor = color;
    context.shadowBlur = (8 + pulse * 24 + focus * 8) * Math.min(scale, 2);
    context.fillStyle = color;
    context.strokeStyle = color;
    context.lineWidth = 1.5 / scale;
    context.beginPath();
    context.arc(node.x, node.y, size, 0, Math.PI * 2);
    if (node.type === "source") context.stroke();
    else context.fill();
    if (pulse) {
      context.fillStyle = "#edf2ff";
      context.globalAlpha *= pulse * 0.55;
      if (node.type === "source") {
        context.strokeStyle = "#edf2ff";
        context.stroke();
      } else context.fill();
      context.globalAlpha = (emphasized(node) ? 1 : 0.09) * pulse * 0.5;
      context.beginPath();
      context.arc(node.x, node.y, size + 5 * pulse, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
    if (node.type === "topic" && scale < 1.6) return;
    const fontSize = Math.max(12, Math.min(16, 13 * Math.sqrt(scale))) / scale;
    context.save();
    context.globalAlpha = emphasized(node) ? 0.95 : 0.16;
    context.font = `500 ${fontSize}px "Segoe UI", Meiryo, sans-serif`;
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 3 / scale;
    context.strokeStyle = "#05060a";
    context.fillStyle = node.type === "source" ? color : "#d5dfea";
    const title = node.type === "source" ? author(node).label : node.label;
    const characters = [...title];
    const label = characters.length > 36 ? `${characters.slice(0, 35).join("")}…` : title;
    const x = node.x + size + 5 / scale;
    context.strokeText(label, x, node.y);
    context.fillText(label, x, node.y);
    context.restore();
  }

  try {
    graph = ForceGraph()(container).pauseAnimation();
    graph
      .width(container.parentElement.clientWidth)
      .height(container.parentElement.clientHeight)
      .backgroundColor("#05060a")
      .autoPauseRedraw(false)
      .minZoom(0.15)
      .maxZoom(8)
      .nodeCanvasObject(drawNode)
      .nodePointerAreaPaint((node, color, context, scale) => {
        context.fillStyle = color;
        context.beginPath();
        context.arc(node.x, node.y, Math.max(radius(node) + 3, 8 / scale), 0, Math.PI * 2);
        context.fill();
      })
      .nodeLabel((node) => {
        const label = document.createElement("span");
        label.textContent = node.label;
        return label;
      })
      .linkLabel(() => "")
      .linkColor((link) => {
        const from = endpoint(link.source);
        const to = endpoint(link.target);
        return from && to && emphasized(from) && emphasized(to) ? "rgba(101,125,147,0.32)" : "rgba(78,92,116,0.08)";
      })
      .linkWidth(0.65)
      .linkDirectionalParticles(0)
      .linkDirectionalParticleSpeed(motionPreference.matches ? 0.035 : 0.013)
      .linkDirectionalParticleWidth(2.5)
      .linkDirectionalParticleColor((link) => link.particleColor || "#d2faff")
      .warmupTicks(100)
      .cooldownTicks(220)
      .onEngineStop(() => {
        if (active && fitPending) fit();
      })
      .onNodeClick(onSelect)
      .onNodeHover((node) => { hoveredId = node?.id || null; })
      .onNodeDrag(cancelAutoFit);
    graph.d3Force("charge").strength(-220);
    graph.d3Force("link").distance((link) => link.type === "MENTIONED_BY" ? 150 : 120).strength(0.12);
    graph.d3Force("source-clusters", clusterForce);
    graph.d3Force("label-spacing", forceCollide((node) => node.type === "memory" ? 55 : 18).strength(0.8).iterations(2));
  } catch (error) {
    graph?.pauseAnimation();
    container.replaceChildren();
    throw error;
  }
  container.addEventListener("pointerdown", cancelAutoFit, { passive: true });
  container.addEventListener("wheel", cancelAutoFit, { passive: true });

  return {
    get split() { return split; },
    resume(nextData) {
      data = nextData;
      layout3d = captureLayout(data.nodes);
      restoreLayout(data.nodes, layout2d);
      active = true;
      fitPending = !layout2d.size || autoFit;
      graph.warmupTicks(100).graphData(data);
      graph.resumeAnimation();
    },
    pause(initialize3D) {
      active = false;
      // Kapsule may still have a queued data update after its animation is paused.
      graph.pauseAnimation().warmupTicks(0);
      layout2d = captureLayout(data.nodes);
      restoreLayout(data.nodes, layout3d, initialize3D);
    },
    updateData(nextData) {
      data = nextData;
      graph.graphData(data);
      if (autoFit) fitPending = true;
    },
    resize(width, height) {
      graph.width(width).height(height);
      if (active && autoFit) fit();
    },
    setSplit(value) {
      split = value;
      autoFit = true;
      graph.d3ReheatSimulation();
      fitPending = true;
    },
    fit(padding) {
      autoFit = true;
      fit(padding);
    },
    cancelAutoFit,
    select(node) {
      autoFit = fitPending = false;
      graph.centerAt(node.x || 0, node.y || 0, duration());
      graph.zoom(Math.max(1.8, graph.zoom()), duration());
    },
    emitParticle(link) { graph.emitParticle(link); },
    updateMotion() {
      graph.linkDirectionalParticleSpeed(motionPreference.matches ? 0.035 : 0.013);
    },
    stop() { active = false; graph.pauseAnimation(); },
  };
}
