import * as THREE from "three";
import ForceGraph3D from "3d-force-graph";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { resolveViewMode } from "./view-mode.js";

const AUTHORS = {
  claude: { label: "Claude", color: "#ffb454", center: [-155, 105, 0] },
  chatgpt: { label: "ChatGPT", color: "#3ee0c8", center: [155, 105, 0] },
  cursor: { label: "Cursor", color: "#b388ff", center: [-155, -105, 0] },
  copilot: { label: "Copilot", color: "#7ee26b", center: [155, -105, 0] },
};
const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const mockMode = query.get("mock") === "1";
const token = loadToken();
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
const activeSources = new Set();
const visuals = new Map();
const arrivals = new Map();
const pulses = new Map();
const pendingEvents = [];
const particleTimers = new Set();
const draggedArrivals = new Set();
let data = { nodes: [], links: [] };
let nodesById = new Map();
let graph;
let graph2d;
let viewMode = "3d";
let changingView = false;
let graph3dDirty = false;
let mock;
let events;
let stopMock;
let refreshTimer;
let reconnectTimer;
let refreshInProgress = false;
let refreshAgain = false;
let tokenRetryAt = 0;
let stopped = false;
let animation;
let selectedId = null;
let hoveredId = null;
let previousFocus;
let splitMode = false;
let lastInteraction = -10000;
let controlsActive = false;
let autoFitEnabled = true;
let initialFitRequested = false;
let fitPending = false;
let fitTimer;
let resizeFitFrame;

function loadViewMode() {
  let saved;
  try {
    saved = localStorage.getItem("jinai-memory-view");
  } catch {
    console.warn("Local storage unavailable. The graph view will not persist across reloads.");
  }
  return resolveViewMode(query.get("view"), saved);
}

function updateViewControls() {
  const flat = viewMode === "2d";
  $("view-toggle").textContent = flat ? "3D view" : "2D view";
  $("view-toggle").setAttribute("aria-pressed", String(flat));
  $("graph3d").hidden = flat;
  $("graph2d").hidden = !flat;
  $("graph").setAttribute("aria-label", `${flat ? "2D" : "3D"} graph. Drag to ${flat ? "pan" : "orbit"}, scroll to zoom. Use Browse memories for keyboard navigation.`);
  document.querySelector(".interaction-hint").firstChild.textContent = `Drag to ${flat ? "pan" : "orbit"} `;
  const split = flat ? graph2d.split : splitMode;
  $("split-toggle").setAttribute("aria-pressed", String(split));
  $("split-toggle").textContent = split ? "Restore force layout" : "Group by AI";
}

async function setViewMode(nextMode) {
  if (stopped || changingView) return;
  changingView = true;
  $("view-toggle").disabled = true;
  $("view-toggle").setAttribute("aria-busy", "true");
  try {
    if (nextMode !== viewMode) {
      if (nextMode === "2d") {
        if (!graph2d) {
          const { createGraph2D } = await import("./graph2d.js");
          if (stopped) return;
          graph2d = await createGraph2D($("graph2d"), {
            author, emphasized, pulses,
            isSelected: (node) => selectedId === node.id,
            onSelect: selectNode, onInteract: markInteraction, motionPreference,
            initialSplit: splitMode,
          });
        }
        if (stopped) { graph2d.stop(); return; }
        graph.pauseAnimation();
        graph2d.resume(data);
      } else {
        graph2d.pause(startArrival);
        if (graph3dDirty) {
          graph.graphData(data);
          graph3dDirty = false;
        }
        graph.resumeAnimation();
      }
      viewMode = nextMode;
    }
    updateViewControls();
    $("view-error").hidden = true;
    try {
      localStorage.setItem("jinai-memory-view", viewMode);
    } catch {
      console.warn("Local storage unavailable. The graph view will not persist across reloads.");
    }
  } catch (error) {
    if (nextMode === "2d") {
      graph2d?.pause(startArrival);
      graph.resumeAnimation();
      viewMode = "3d";
      updateViewControls();
    }
    $("view-error").textContent = "2D unavailable. Continuing in 3D. / 2D を読み込めません。3D で表示を続けます。";
    $("view-error").hidden = false;
    console.error("Graph view switch failed:", error.name, error.message);
  } finally {
    changingView = false;
    $("view-toggle").disabled = false;
    $("view-toggle").setAttribute("aria-busy", "false");
  }
}

function readToken(search) {
  const match = search.match(/(?:^\?|&)token(?:=([^&]*))?(?=&|$)/);
  return match ? decodeURIComponent(match[1] || "") : null;
}

function loadToken() {
  let value;
  try {
    value = readToken(location.search);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    value = "";
    console.warn("Invalid token encoding. Open the page with ?token=... again.");
  }
  if (query.has("token")) {
    value ??= "";
    query.delete("token");
    const search = query.toString();
    history.replaceState(history.state, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
  }
  try {
    if (value !== null) sessionStorage.setItem("jinai-memory-token", value);
    else value = sessionStorage.getItem("jinai-memory-token");
  } catch {
    console.warn("Session storage unavailable. The token will not persist across reloads.");
  }
  return value;
}

function sourceKey(node) {
  return String(node.type === "source" ? node.source || node.label : node.source || "").toLowerCase();
}

function author(node) {
  const key = sourceKey(node);
  return AUTHORS[key] || { label: node.source || (node.type === "source" ? node.label : "Other"), color: "#edf2ff", center: [0, 0, 0] };
}

function emphasized(node) {
  return !activeSources.size || node.type === "topic" || activeSources.has(sourceKey(node));
}

function endpointId(endpoint) {
  return typeof endpoint === "object" ? endpoint.id : endpoint;
}

function showMessage(title, text, loading = false) {
  $("graph-message").hidden = false;
  $("message-title").textContent = title;
  $("message-text").textContent = text;
  document.querySelector(".loading-orbit").hidden = !loading;
}

function connection(text, state) {
  $("connection-status").textContent = text;
  $("connection-dot").dataset.state = state;
}

function markInteraction() {
  lastInteraction = performance.now();
  if (graph && viewMode === "3d") graph.controls().autoRotate = false;
}

function cancelAutoFit() {
  if (viewMode === "2d") {
    graph2d.cancelAutoFit();
    return;
  }
  autoFitEnabled = false;
  fitPending = false;
  clearTimeout(fitTimer);
  cancelAnimationFrame(resizeFitFrame);
}

function fitGraph(padding = 60) {
  if (viewMode === "2d") {
    graph2d.fit(padding);
    return;
  }
  const duration = motionPreference.matches ? 0 : 700;
  if (data.nodes.length < 2) {
    graph.cameraPosition({ x: 0, y: 30, z: 520 }, { x: 0, y: 0, z: 0 }, duration);
  } else {
    graph.zoomToFit(duration, padding);
  }
}

function finishAutoFit() {
  if (stopped || viewMode === "2d" || !autoFitEnabled || !fitPending) return;
  fitPending = false;
  clearTimeout(fitTimer);
  fitGraph();
}

function requestAutoFit(initial = false) {
  if (stopped || !autoFitEnabled) return;
  fitPending = true;
  clearTimeout(fitTimer);
  if (data.nodes.length < 2) finishAutoFit();
  else if (initial) fitTimer = setTimeout(finishAutoFit, 1500);
}

function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.codePointAt(0), 16777619);
  return result >>> 0;
}

function targetPosition(node, index) {
  const seed = hash(node.id);
  const angle = (seed % 6283) / 1000;
  const radius = node.type === "source" ? 125 : node.type === "topic" ? 48 : 65 + (seed % 65);
  const center = splitMode && node.type !== "topic" ? author(node).center : [0, 0, 0];
  return new THREE.Vector3(
    center[0] + Math.cos(angle) * radius,
    center[1] + Math.sin(angle) * radius * 0.7,
    center[2] + Math.sin(index * 2.399 + angle) * radius * 0.65,
  );
}

function releaseArrival(node) {
  delete node.fx;
  delete node.fy;
  delete node.fz;
  arrivals.delete(node.id);
}

function startArrival(node, index) {
  const target = targetPosition(node, index);
  if (motionPreference.matches) {
    Object.assign(node, { x: target.x, y: target.y, z: target.z });
    return;
  }
  const phase = (hash(node.id) % 1000) / 100;
  const start = target.clone().add(new THREE.Vector3(Math.cos(phase) * 420, 200 + Math.sin(phase) * 160, Math.sin(phase) * 380));
  Object.assign(node, { x: start.x, y: start.y, z: start.z, fx: start.x, fy: start.y, fz: start.z });
  arrivals.set(node.id, { start, target, phase, at: performance.now() + Math.min(index * 35, 650) });
}

function makeGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A 2D canvas is required for node halos.");
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.18, "rgba(255,255,255,0.45)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.09)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return canvas;
}

function labelSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 80;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A 2D canvas is required for graph labels.");
  context.font = '500 29px "Segoe UI", Meiryo, sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#d5dfea";
  context.fillText(text, 256, 40, 490);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false, toneMapped: false,
  }));
  sprite.scale.set(48, 7.5, 1);
  sprite.position.y = 9;
  return sprite;
}

function makeNode(node) {
  const group = new THREE.Group();
  const radius = node.type === "memory" ? 2.5 : node.type === "topic" ? 1.25 : 4.8;
  const color = node.type === "topic" ? "#c8d7ed" : author(node).color;
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, toneMapped: false, depthWrite: false });
  const geometry = node.type === "source"
    ? new THREE.TorusGeometry(radius, 0.65, 10, 40)
    : new THREE.SphereGeometry(radius, 14, 12);
  const core = new THREE.Mesh(geometry, material);
  group.add(core);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(makeGlowTexture()),
    color, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  halo.scale.setScalar(radius * 10);
  group.add(halo);
  let label;
  if (node.type !== "memory") {
    label = labelSprite(`${node.type === "source" ? author(node).label : node.label} · ${node.type}`);
    group.add(label);
  }
  visuals.set(node.id, { group, core, halo, label, color: new THREE.Color(color) });
  return group;
}

function linkColor(link) {
  const from = nodesById.get(endpointId(link.source));
  const to = nodesById.get(endpointId(link.target));
  if (!from || !to || !emphasized(from) || !emphasized(to)) return "rgba(78,92,116,0.15)";
  return from.type === "memory" && to.type === "memory" && sourceKey(from) !== sourceKey(to) ? "#b1a9cf" : "#657d93";
}

function addStars() {
  const positions = new Float32Array(360 * 3);
  for (let index = 0; index < 360; index++) {
    const angle = index * 2.399963;
    const y = 1 - 2 * (index + 0.5) / 360;
    const ring = Math.sqrt(1 - y * y);
    positions.set([Math.cos(angle) * ring * 1100, y * 1100, Math.sin(angle) * ring * 1100], index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  graph.scene().add(new THREE.Points(geometry, new THREE.PointsMaterial({
    color: "#9dabc8", size: 0.8, transparent: true, opacity: 0.35, depthWrite: false,
  })));
}

function clusterForce(alpha) {
  if (!splitMode) return;
  for (const node of data.nodes) {
    const center = node.type === "topic" ? [0, 0, 0] : author(node).center;
    for (let axis = 0; axis < 3; axis++) {
      const dimension = ["x", "y", "z"][axis];
      node[`v${dimension}`] += (center[axis] - node[dimension]) * alpha * (node.type === "topic" ? 0.035 : 0.16);
    }
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.links)) throw new Error("Invalid graph snapshot");
  const ids = new Set();
  for (const node of snapshot.nodes) {
    if (!node || typeof node.id !== "string" || !node.id || ids.has(node.id) ||
        !["memory", "topic", "source"].includes(node.type) || typeof node.label !== "string" ||
        (node.text != null && typeof node.text !== "string") ||
        (node.source != null && typeof node.source !== "string") ||
        (node.tags != null && (!Array.isArray(node.tags) || node.tags.some((tag) => typeof tag !== "string")))) {
      throw new Error("Invalid graph node");
    }
    ids.add(node.id);
  }
  for (const link of snapshot.links) {
    if (!link || !ids.has(link.source) || !ids.has(link.target) || typeof link.type !== "string" ||
        (link.w != null && (typeof link.w !== "number" || !Number.isFinite(link.w)))) throw new Error("Invalid graph link");
  }
}

function syncGraph(snapshot) {
  validateSnapshot(snapshot);
  const previousLinks = new Map(data.links.map((link) => [link.key, link]));
  let topologyChanged = data.nodes.length !== snapshot.nodes.length || data.links.length !== snapshot.links.length;
  const nodes = snapshot.nodes.map((raw, index) => {
    const existing = nodesById.get(raw.id);
    if (existing) {
      Object.assign(existing, raw);
      return existing;
    }
    topologyChanged = true;
    const node = { ...raw };
    if (viewMode === "3d") startArrival(node, index);
    return node;
  });
  nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const id of visuals.keys()) {
    if (!nodesById.has(id)) {
      visuals.delete(id);
      arrivals.delete(id);
      pulses.delete(id);
    }
  }
  const links = snapshot.links.map((raw) => {
    const key = JSON.stringify([raw.source, raw.target, raw.type]);
    const existing = previousLinks.get(key);
    if (existing) {
      existing.w = raw.w ?? 1;
      return existing;
    }
    topologyChanged = true;
    return { ...raw, w: raw.w ?? 1, key, source: nodesById.get(raw.source), target: nodesById.get(raw.target) };
  });
  data = { nodes, links };
  if (topologyChanged) {
    if (viewMode === "2d") {
      graph3dDirty = true;
      graph2d.updateData(data);
    } else graph.graphData(data);
  }
  if (!initialFitRequested) {
    initialFitRequested = true;
    requestAutoFit(true);
  }
  $("graph-count").textContent = `${nodes.filter((node) => node.type === "memory").length} memories · ${links.length} connections`;
  if (nodes.length) $("graph-message").hidden = true;
  else showMessage("A quiet constellation", "No memories yet. Save a thought from an AI tool to start.");
  updateFilters();
  if (selectedId && nodesById.has(selectedId)) renderDetails(nodesById.get(selectedId));
  else if (selectedId) closeDetails();
  for (let index = pendingEvents.length - 1; index >= 0; index--) {
    const pending = pendingEvents[index];
    if (performance.now() - pending.at > 30000) {
      pendingEvents.splice(index, 1);
    } else if (pending.event.nodeIds.every((id) => nodesById.has(id))) {
      applyTouch(pending.event, pending.focus);
      pendingEvents.splice(index, 1);
    }
  }
}

function apiUrl(path) {
  const url = new URL(path, location.href);
  if (token) url.search = `?token=${encodeURIComponent(token)}`;
  return url;
}

async function refreshGraph() {
  if (stopped || (!mockMode && (!token || Date.now() < tokenRetryAt))) return;
  if (refreshInProgress) {
    refreshAgain = true;
    return;
  }
  clearTimeout(refreshTimer);
  refreshInProgress = true;
  let success = false;
  try {
    let snapshot;
    if (mockMode) {
      snapshot = await mock.readGraph();
    } else {
      const response = await fetch(apiUrl("/api/graph"), { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (response.status === 404) {
        tokenRetryAt = Date.now() + 30000;
        events?.close();
        events = null;
        clearTimeout(reconnectTimer);
        connection("Token not recognized", "error");
        $("event-error").hidden = true;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      snapshot = await response.json();
    }
    if (stopped) return;
    syncGraph(snapshot);
    $("graph-error").hidden = true;
    success = true;
    if (!mockMode && tokenRetryAt) {
      tokenRetryAt = 0;
      connectEvents();
    }
  } catch (error) {
    if (stopped) return;
    const reason = /^HTTP \d{3}$/.test(error.message) ? ` (${error.message})` : "";
    $("graph-error").textContent = tokenRetryAt
      ? "Token not recognized. Open the page with ?token=... again. / トークンが一致しません。URL の ?token= を確認してください"
      : `Graph unavailable${reason}. Retrying in 5s.`;
    $("graph-error").hidden = false;
    if (!data.nodes.length) showMessage("Waiting for memories", "The graph could not be loaded. Retrying automatically.");
    console.error("Graph refresh failed:", /^HTTP \d{3}$/.test(error.message) ? error.message : error.name);
  } finally {
    refreshInProgress = false;
    const delay = tokenRetryAt ? 30000 : refreshAgain ? 0 : success ? 30000 : 5000;
    refreshAgain = false;
    if (!stopped) refreshTimer = setTimeout(refreshGraph, delay);
  }
}

function distancesFrom(seeds) {
  const distances = new Map(seeds.filter((id) => nodesById.has(id)).map((id) => [id, 0]));
  const adjacency = new Map(data.nodes.map((node) => [node.id, []]));
  for (const link of data.links) {
    const from = endpointId(link.source);
    const to = endpointId(link.target);
    adjacency.get(from).push(to);
    adjacency.get(to).push(from);
  }
  const queue = [...distances.keys()];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const neighbor of adjacency.get(id)) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, distances.get(id) + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

function applyTouch(event, focus) {
  const now = performance.now();
  const touched = new Set(event.nodeIds);
  for (const id of touched) {
    if (nodesById.has(id)) pulses.set(id, now);
  }
  const distances = distancesFrom(event.op === "remember" ? focus : event.nodeIds);
  const firstDistances = distancesFrom([event.nodeIds[0]]);
  for (const link of data.links) {
    let from = endpointId(link.source);
    let to = endpointId(link.target);
    if (!touched.has(from) && !touched.has(to)) continue;
    let fromDistance = distances.get(from) ?? Infinity;
    let toDistance = distances.get(to) ?? Infinity;
    if (fromDistance === toDistance) {
      fromDistance = firstDistances.get(from) ?? Infinity;
      toDistance = firstDistances.get(to) ?? Infinity;
    }
    const reverse = event.op === "remember" ? fromDistance < toDistance : fromDistance > toDistance;
    if (reverse) [from, to] = [to, from];
    // Edges are rendered without arrows; orient each used edge for this call's single-hop particles.
    link.source = nodesById.get(from);
    link.target = nodesById.get(to);
    link.particleColor = AUTHORS[String(event.source).toLowerCase()]?.color || "#edf2ff";
    const renderer = viewMode === "2d" ? graph2d : graph;
    const particleView = viewMode;
    renderer.emitParticle(link);
    if (!motionPreference.matches) {
      for (const delay of [100, 220]) {
        const timer = setTimeout(() => {
          particleTimers.delete(timer);
          if (!stopped && viewMode === particleView && data.links.includes(link)) renderer.emitParticle(link);
        }, delay);
        particleTimers.add(timer);
      }
    }
  }
}

function logEvent(event) {
  const row = document.createElement("li");
  const source = AUTHORS[String(event.source).toLowerCase()];
  row.textContent = `${source?.label || event.source} ${event.op} → ${event.nodeIds.length} nodes`;
  row.style.setProperty("--source", source?.color || "#edf2ff");
  row.dataset.at = String(performance.now());
  $("activity-list").prepend(row);
  while ($("activity-list").children.length > 6) $("activity-list").lastElementChild.remove();
}

function receiveEvent(event) {
  if (!event || !["remember", "open", "recall", "orient"].includes(event.op) ||
      typeof event.source !== "string" || !Array.isArray(event.nodeIds) ||
      event.nodeIds.some((id) => typeof id !== "string")) {
    $("event-error").textContent = "An invalid live event was ignored.";
    $("event-error").hidden = false;
    return;
  }
  const missing = event.nodeIds.filter((id) => !nodesById.has(id));
  const focus = missing.length ? missing : [event.nodeIds[0]];
  logEvent(event);
  applyTouch(event, focus);
  if (missing.length) {
    pendingEvents.push({ event, focus, at: performance.now() });
    if (pendingEvents.length > 30) pendingEvents.shift();
  }
  if (event.op === "remember" || missing.length) void refreshGraph();
}

function connectEvents() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  if (mockMode) {
    connection("Mock · simulated every 3s", "live");
    stopMock = mock.subscribe(receiveEvent);
    return;
  }
  if (!token || tokenRetryAt) {
    connection(token ? "Token not recognized" : "Token required", "error");
    return;
  }
  if (!("EventSource" in window)) {
    connection("Live events unavailable", "error");
    $("event-error").textContent = "This browser does not support live events. The graph still refreshes every 30s.";
    $("event-error").hidden = false;
    return;
  }
  events?.close();
  events = new EventSource(apiUrl("/events"));
  events.onopen = () => {
    if (stopped) return;
    connection("Live · shared memory", "live");
    $("event-error").hidden = true;
    void refreshGraph();
  };
  events.onerror = () => {
    if (stopped) return;
    connection("Live events reconnecting", "error");
    $("event-error").textContent = "Live connection interrupted. Reconnecting automatically.";
    $("event-error").hidden = false;
    if (events.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectEvents, 5000);
    }
  };
  events.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch (error) {
      console.error("Invalid live event JSON:", error.name);
      $("event-error").textContent = "An unreadable live event was ignored.";
      $("event-error").hidden = false;
      return;
    }
    receiveEvent(event);
  };
}

function nodeButton(node, suffix = "") {
  const button = document.createElement("button");
  button.type = "button";
  const dot = document.createElement("span");
  dot.className = "source-dot";
  dot.style.setProperty("--source", author(node).color);
  dot.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "node-copy";
  const title = document.createElement("span");
  title.textContent = node.label;
  const meta = document.createElement("small");
  meta.textContent = `${node.type === "topic" ? "Topic" : author(node).label} · ${node.kind || node.type}${suffix}`;
  copy.append(title, meta);
  button.append(dot, copy);
  button.addEventListener("click", () => selectNode(node));
  return button;
}

function renderBrowser() {
  const search = $("memory-search").value.trim().toLocaleLowerCase();
  const fragment = document.createDocumentFragment();
  for (const node of data.nodes) {
    if (node.type !== "memory" || !emphasized(node) || !node.label.toLocaleLowerCase().includes(search)) continue;
    const row = document.createElement("li");
    row.append(nodeButton(node));
    fragment.append(row);
  }
  if (!fragment.childNodes.length) {
    const empty = document.createElement("li");
    empty.className = "list-empty";
    empty.textContent = "No memories match. Try another title or show all authors.";
    fragment.append(empty);
  }
  $("memory-list").replaceChildren(fragment);
}

function updateFilters() {
  for (const button of document.querySelectorAll("[data-source]")) {
    button.setAttribute("aria-pressed", String(activeSources.has(button.dataset.source)));
    button.querySelector(".source-count").textContent = String(data.nodes.filter((node) => node.type === "memory" && sourceKey(node) === button.dataset.source).length);
  }
  $("filter-description").textContent = activeSources.size
    ? `Focused: ${[...activeSources].map((key) => AUTHORS[key].label).join(", ")}. Others are dimmed.`
    : "All authors visible. Select to focus.";
  if (graph) graph.linkColor(linkColor);
  if (!$("browser").hidden) renderBrowser();
}

function renderDetails(node) {
  $("detail-title").textContent = node.label;
  $("detail-type").textContent = node.type.toUpperCase();
  $("detail-source").textContent = node.type === "topic" ? "Shared topic" : author(node).label;
  $("detail-source").style.setProperty("--source", node.type === "topic" ? "#d5dfea" : author(node).color);
  $("detail-kind").textContent = node.kind || node.type;
  const rawDate = node.occurredAt || node.createdAt;
  const date = rawDate ? new Date(rawDate) : null;
  const validDate = date && Number.isFinite(date.getTime());
  $("detail-date").textContent = validDate ? `${node.occurredAt ? "Occurred" : "Created"} ${date.toLocaleString()}` : "Date not recorded";
  if (validDate) $("detail-date").dateTime = date.toISOString();
  else $("detail-date").removeAttribute("datetime");
  $("detail-summary").textContent = typeof node.summary === "string" ? node.summary : "";
  $("detail-summary").hidden = !$("detail-summary").textContent;
  $("detail-body").innerHTML = renderMarkdown(node.text || (node.type === "memory" ? "This memory has no body yet." : node.type === "topic" ? "Explore the memories connected to this topic below." : "Memories written by this AI are connected below."));
  $("detail-tags").replaceChildren(...(node.tags || []).map((tag) => {
    const badge = document.createElement("span");
    badge.textContent = tag;
    return badge;
  }));
  const neighbors = new Map();
  for (const link of data.links) {
    const from = endpointId(link.source);
    const to = endpointId(link.target);
    const neighbor = from === node.id ? to : to === node.id ? from : null;
    if (neighbor) {
      if (!neighbors.has(neighbor)) neighbors.set(neighbor, new Set());
      neighbors.get(neighbor).add(link.type);
    }
  }
  const rows = [...neighbors].map(([id, types]) => {
    const row = document.createElement("li");
    row.append(nodeButton(nodesById.get(id), ` · ${[...types].join(", ")}`));
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "list-empty";
    empty.textContent = "No connections yet.";
    rows.push(empty);
  }
  $("connected-list").replaceChildren(...rows);
}

function selectNode(node) {
  cancelAutoFit();
  markInteraction();
  if (!selectedId) previousFocus = document.activeElement;
  selectedId = node.id;
  pulses.set(node.id, performance.now());
  renderDetails(node);
  $("details").hidden = false;
  document.body.classList.add("details-open");
  $("detail-close").focus({ preventScroll: true });
  if (viewMode === "2d") {
    graph2d.select(node);
    return;
  }
  const target = new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0);
  const direction = graph.camera().position.clone().sub(target).normalize();
  if (!direction.lengthSq()) direction.set(0, 0, 1);
  const position = target.clone().addScaledVector(direction, 140);
  graph.cameraPosition(position, target, motionPreference.matches ? 0 : 700);
}

function closeDetails() {
  selectedId = null;
  $("details").hidden = true;
  document.body.classList.remove("details-open");
  if (previousFocus?.isConnected && previousFocus !== document.body) previousFocus.focus({ preventScroll: true });
  else $("browse-toggle").focus({ preventScroll: true });
}

function toggleBrowser(open) {
  $("browser").hidden = !open;
  $("browse-toggle").setAttribute("aria-expanded", String(open));
  if (open) {
    renderBrowser();
    $("memory-search").focus();
  } else {
    $("browse-toggle").focus();
  }
}

function animate(now) {
  if (stopped) return;
  for (const [id, entry] of viewMode === "3d" ? arrivals : []) {
    const node = nodesById.get(id);
    if (!node) continue;
    if (motionPreference.matches) {
      Object.assign(node, { x: entry.target.x, y: entry.target.y, z: entry.target.z });
      releaseArrival(node);
      continue;
    }
    const t = THREE.MathUtils.clamp((now - entry.at) / 2400, 0, 1);
    const ease = 1 - (1 - t) ** 3;
    const curve = Math.sin(Math.PI * t) * 75;
    for (const [index, axis] of ["x", "y", "z"].entries()) {
      const offset = curve * (Math.sin(t * 5 + entry.phase + index * 2) + 0.35 * Math.sin(t * 9 + index));
      node[axis] = node[`f${axis}`] = THREE.MathUtils.lerp(entry.start[axis], entry.target[axis], ease) + offset;
    }
    if (t >= 1) releaseArrival(node);
  }
  for (const [id, visual] of viewMode === "3d" ? visuals : []) {
    const node = nodesById.get(id);
    if (!node) continue;
    const elapsed = now - (pulses.get(id) ?? -Infinity);
    const pulse = elapsed < 200 ? elapsed / 200 : elapsed < 2200 ? (1 - (elapsed - 200) / 2000) ** 2 : 0;
    if (elapsed >= 2200) pulses.delete(id);
    const focus = hoveredId === id || selectedId === id ? 0.65 : 0;
    const opacity = emphasized(node) ? 1 : 0.09;
    visual.color.set(node.type === "topic" ? "#c8d7ed" : author(node).color);
    visual.core.material.color.copy(visual.color).multiplyScalar(1.25 + pulse * 3.8 + focus);
    visual.core.material.opacity = opacity;
    visual.core.scale.setScalar(1 + pulse * 0.65 + focus * 0.2);
    visual.halo.material.color.copy(visual.color);
    visual.halo.material.opacity = (0.32 + pulse * 0.65 + focus * 0.2) * opacity;
    if (visual.label) visual.label.material.opacity = emphasized(node) ? 0.9 : 0.16;
    if (node.type === "source") visual.core.quaternion.copy(graph.camera().quaternion);
  }
  for (const row of [...$("activity-list").children]) {
    const age = now - Number(row.dataset.at);
    if (age > 21000) row.remove();
    else row.style.opacity = String(Math.max(0, 1 - age / 22000));
  }
  if (viewMode === "3d") graph.controls().autoRotate = !motionPreference.matches && !controlsActive && now - lastInteraction >= 10000;
  animation = requestAnimationFrame(animate);
}

function webglAvailable() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
  if (!context) return false;
  context.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

function stop() {
  stopped = true;
  cancelAutoFit();
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  for (const timer of particleTimers) clearTimeout(timer);
  cancelAnimationFrame(animation);
  events?.close();
  stopMock?.();
  graph?.pauseAnimation();
  graph2d?.stop();
}

async function start() {
  if (!mockMode && !token) {
    const message = "Add ?token=... to the URL, or use ?mock=1 / URL に ?token= を付けるか、?mock=1 で試せます";
    $("graph-error").textContent = message;
    $("graph-error").hidden = false;
    showMessage("Token required", message);
    connection("Token required", "error");
    return;
  }
  if (!webglAvailable()) {
    showMessage("WebGL が必要です", "WebGL is required. Enable hardware acceleration or use a WebGL-capable browser.");
    connection("WebGL unavailable", "error");
    return;
  }
  if (mockMode) mock = (await import("./mock.js")).createMockSource();
  graph = ForceGraph3D({ controlType: "orbit", rendererConfig: { antialias: true, powerPreference: "high-performance" } })($("graph3d"))
    .backgroundColor("#05060a")
    .showNavInfo(false)
    .nodeThreeObject(makeNode)
    .nodeLabel((node) => escapeHtml(`${node.label} · ${node.type === "topic" ? "Topic" : author(node).label} · ${node.kind || node.type}`))
    .linkLabel((link) => escapeHtml(link.type))
    .linkColor(linkColor)
    .linkWidth(0)
    .linkOpacity(0.25)
    .linkDirectionalParticles(0)
    .linkDirectionalParticleSpeed(motionPreference.matches ? 0.035 : 0.013)
    .linkDirectionalParticleWidth(1.8)
    .linkDirectionalParticleResolution(8)
    .linkDirectionalParticleColor((link) => link.particleColor || "#d2faff")
    .warmupTicks(motionPreference.matches ? 100 : 0)
    .cooldownTicks(320)
    .onEngineStop(finishAutoFit)
    .onNodeClick(selectNode)
    .onNodeHover((node) => { hoveredId = node?.id || null; })
    .onNodeDrag((node) => {
      cancelAutoFit();
      markInteraction();
      if (arrivals.delete(node.id)) draggedArrivals.add(node.id);
    })
    .onNodeDragEnd((node) => {
      markInteraction();
      if (draggedArrivals.delete(node.id)) releaseArrival(node);
    });
  graph.d3Force("charge").strength(-85);
  graph.d3Force("link").distance((link) => link.type === "MENTIONED_BY" ? 85 : 60).strength(0.12);
  graph.d3Force("source-clusters", clusterForce);
  const controls = graph.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.autoRotateSpeed = 0.24;
  controls.minDistance = 35;
  controls.maxDistance = 1700;
  controls.addEventListener("start", () => { controlsActive = true; cancelAutoFit(); markInteraction(); });
  controls.addEventListener("end", () => { controlsActive = false; markInteraction(); });
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.25, 0.65, 0.7);
  graph.renderer().setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  graph.postProcessingComposer().setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  graph.postProcessingComposer().addPass(bloom);
  const observer = new ResizeObserver(([entry]) => {
    graph.width(entry.contentRect.width).height(entry.contentRect.height);
    graph2d?.resize(entry.contentRect.width, entry.contentRect.height);
    cancelAnimationFrame(resizeFitFrame);
    if (viewMode === "3d" && initialFitRequested && autoFitEnabled && !fitPending && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
      resizeFitFrame = requestAnimationFrame(() => {
        if (!stopped && viewMode === "3d" && autoFitEnabled && !fitPending) fitGraph();
      });
    }
  });
  observer.observe($("graph"));
  addStars();
  $("stage").addEventListener("pointerdown", markInteraction, { passive: true });
  $("stage").addEventListener("wheel", markInteraction, { passive: true });
  document.addEventListener("keydown", (event) => {
    markInteraction();
    if (event.key === "Escape") {
      if (!$("details").hidden) closeDetails();
      else if (!$("browser").hidden) toggleBrowser(false);
    }
  });
  $("view-toggle").addEventListener("click", () => { void setViewMode(viewMode === "3d" ? "2d" : "3d"); });
  $("split-toggle").addEventListener("click", () => {
    if (viewMode === "2d") {
      graph2d.setSplit(!graph2d.split);
      updateViewControls();
      return;
    }
    splitMode = !splitMode;
    $("split-toggle").setAttribute("aria-pressed", String(splitMode));
    $("split-toggle").textContent = splitMode ? "Restore force layout" : "Group by AI";
    requestAutoFit();
    graph.d3ReheatSimulation();
  });
  $("fit-view").addEventListener("click", () => {
    if (viewMode === "2d") {
      graph2d.fit(110);
      return;
    }
    cancelAutoFit();
    autoFitEnabled = true;
    fitGraph(85);
  });
  $("browse-toggle").addEventListener("click", () => toggleBrowser($("browser").hidden));
  $("browse-close").addEventListener("click", () => toggleBrowser(false));
  $("memory-search").addEventListener("input", renderBrowser);
  $("detail-close").addEventListener("click", closeDetails);
  for (const button of document.querySelectorAll("[data-source]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.source;
      if (activeSources.has(key)) activeSources.delete(key);
      else activeSources.add(key);
      updateFilters();
    });
  }
  $("clear-filters").addEventListener("click", () => { activeSources.clear(); updateFilters(); });
  motionPreference.addEventListener("change", () => {
    markInteraction();
    graph.linkDirectionalParticleSpeed(motionPreference.matches ? 0.035 : 0.013);
    graph2d?.updateMotion();
  });
  graph.renderer().domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    stop();
    showMessage("WebGL context lost", "Reload the page to restart the constellation.");
    connection("Renderer stopped", "error");
  });
  window.addEventListener("pagehide", () => { observer.disconnect(); stop(); }, { once: true });
  animation = requestAnimationFrame(animate);
  await refreshGraph();
  if (!stopped) connectEvents();
  if (!stopped) await setViewMode(loadViewMode());
}

start().catch((error) => {
  stop();
  showMessage("The graph could not start", "The renderer could not initialize. Check WebGL support and your connection to jsDelivr, then reload.");
  connection("Graph unavailable", "error");
  console.error("Graph initialization failed:", error.name, error.message);
});
