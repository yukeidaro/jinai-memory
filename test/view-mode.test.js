import assert from "node:assert/strict";
import test from "node:test";
import { resolveViewMode } from "../public/view-mode.js";
import { captureLayout, restoreLayout, pulseStrength } from "../public/graph2d.js";

test("view mode defaults to 3D on the first visit", () => {
  assert.equal(resolveViewMode(null, null), "3d");
  assert.equal(resolveViewMode(undefined, undefined), "3d");
});

test("URL view takes precedence over the saved view", () => {
  assert.equal(resolveViewMode("2d", "3d"), "2d");
  assert.equal(resolveViewMode("3d", "2d"), "3d");
});

test("saved view is used when there is no URL override", () => {
  assert.equal(resolveViewMode(null, "2d"), "2d");
  assert.equal(resolveViewMode(null, "3d"), "3d");
});

test("invalid URL values default to 3D even when 2D was saved", () => {
  for (const invalid of ["", "2D", "3D", "flat", "undefined", "null", 2, false]) {
    assert.equal(resolveViewMode(invalid, "2d"), "3d");
  }
});

test("invalid saved values default to 3D", () => {
  for (const invalid of ["", "2D", "flat", "null", 2, false]) {
    assert.equal(resolveViewMode(null, invalid), "3d");
  }
});

test("switching layouts restores 3D physics without copying graph data", () => {
  const nodes = [
    { id: "memory", label: "A memory", x: 10, y: 20, z: 30, vx: 1, vy: 2, vz: 3, fx: 10 },
    { id: "topic", label: "A topic", x: 4, y: 5, z: 6 },
  ];
  const original = structuredClone(nodes);
  const layout3d = captureLayout(nodes);
  const memory = nodes[0];
  restoreLayout(nodes, new Map());
  assert.equal(nodes[0], memory);
  assert.equal(nodes[0].x, undefined);
  assert.equal(nodes[0].fx, undefined);
  Object.assign(memory, { x: -100, y: 200, vx: 8, vy: 9, fy: 200 });
  memory.label = "Updated while in 2D";
  restoreLayout(nodes, layout3d);
  assert.deepEqual(nodes, [{ ...original[0], label: memory.label }, original[1]]);
  assert.equal(nodes[0], memory);
});

test("new nodes are initialized in the destination layout and removed nodes stay removed", () => {
  const layout = captureLayout([{ id: "removed", x: 1 }, { id: "existing", x: 2, z: 3 }]);
  const nodes = [{ id: "existing", x: 500, fy: 99 }, { id: "new", x: 600, fx: 600 }];
  const initialized = [];
  restoreLayout(nodes, layout, (node, index) => {
    initialized.push([node.id, index]);
    node.x = 40;
  });
  assert.deepEqual(nodes, [{ id: "existing", x: 2, z: 3 }, { id: "new", x: 40 }]);
  assert.deepEqual(initialized, [["new", 1]]);
});

test("2D pulses use the same 200ms rise and 2200ms decay as 3D", () => {
  assert.equal(pulseStrength(-1), 0);
  assert.equal(pulseStrength(0), 0);
  assert.equal(pulseStrength(100), 0.5);
  assert.equal(pulseStrength(200), 1);
  assert.equal(pulseStrength(1200), 0.25);
  assert.equal(pulseStrength(2200), 0);
  assert.equal(pulseStrength(Infinity), 0);
});
