/* The dependency graph, in two modes.
 *
 * WHY TWO MODES, measured rather than assumed. At the latest month the drawn graph is 672
 * nodes and 1,010 edges, and:
 *
 *   82% of nodes are leaves, nothing depends on them
 *   median in-degree is 0, the maximum is 478
 *   Mathlib alone accounts for 47% of every edge
 *   71% of drawn nodes sit inside Mathlib's direct star
 *   272 nodes are pure pendants: they require only Mathlib and nothing requires them
 *
 * So the whole-graph picture has about fifteen nodes carrying structure and five hundred
 * carrying none. No layout algorithm fixes that, because the emptiness is in the data.
 * A layered (dot-style) layout is actively worse here: the longest path is 8 levels, but
 * 67% of nodes land on level 3 alone, which is a row 452 wide.
 *
 * What IS well conditioned is the per-package neighbourhood: median 1 neighbour, 90th
 * percentile 3, and 99% of packages have 12 or fewer. That renders exactly as it should
 * as a small layered DAG with real arrows, so it is the default. The whole-graph force
 * layout stays available, because it does communicate one true thing about the ecosystem.
 *
 * Two encodings that must not be confused: node FILL is what the package itself requires
 * (outgoing), node AREA and the dark RING are how many packages depend on it (incoming).
 */

import { CLASSES, CLS, color, cssv, hideTip, num, plural, say, showTip, tag } from "./dom.js";
import { state, syncHash } from "./state.js";
import { HUB_MIN, isHub, MATHLIB, matchesQuery, scopedAt, world } from "./world.js";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");

/* Focus mode geometry, in layout units. The camera scales these to fit. */
const ROW_CAP = 24;        // dependents shown individually before overflowing into a pill
const PER_SUBROW = 12;     // items per sub-row; more than this and labels collide
const SUBROW_GAP = 78;
const ROW_GAP = 190;       // vertical distance from the focus node to the first sub-row
const ROW_MAX_WIDTH = 1500;   // layout units before a sub-row wraps
const MIN_PENDANTS = 4;
/* One shape, one set of numbers. The aggregate pill's half-height was independently
   written as 13, 14, 15 and 26/2 in bounds(), the edge trim, the hit test and the draw. */
const PILL_H = 26;
const aggHalfH = (n) => (n.kind === "agg" ? PILL_H / 2 : n.r);    // below this, aggregating costs more clarity than it buys

let canvas = null;
let ctx = null;
let onOpen = () => {};

let G = { nodes: [], edges: [], byId: new Map(), hubs: [] };
const sim = { alpha: 0, raf: 0 };
const cam = { x: 0, y: 0, k: 1 };

let hoverNode = null;
let dragNode = null;
let dragTravel = 0;
let downPt = null;
let panning = false;
let last = null;
let userMoved = false;
let kbIndex = -1;

/* Ephemeral view state: which aggregate pills the reader has expanded. Not in the URL,
   because it is a transient "show me those" rather than something worth sharing. */
const expanded = new Set();

const matches = (n) => state.query && n.kind === "pkg" && matchesQuery(n, state.query);

/* The selected package plus its direct neighbours, or null when nothing is selected.
 *
 * This walk existed three times: once to print the neighbour count, once to decide which
 * nodes to dim, and once to pick label candidates. draw() built it and threw it away
 * immediately before calling drawLabels, which rebuilt it in the same frame. */
/* The small inline button both notes use. Sizing lives in app.css under .gnote .btn,
   like everything else in this file. */
function noteButton(label, onClick) {
  const b = tag("button", "btn", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function egoOf(id = state.selected) {
  if (!id || !G.byId.has(id)) return null;
  const set = new Set([id]);
  for (const e of G.edges) {
    if (e.s.id === id) set.add(e.t.id);
    if (e.t.id === id) set.add(e.s.id);
  }
  return set;
}
const isFocusMode = () => state.graphMode !== "all";

/* ---------- setup ---------- */

export function initGraph(handlers) {
  onOpen = handlers.open;
  canvas = document.getElementById("gcanvas");
  ctx = canvas.getContext("2d");

  document.querySelectorAll("#graphMode button").forEach((b) => {
    b.addEventListener("click", () => {
      state.graphMode = b.dataset.g;
      expanded.clear();
      userMoved = false;
      syncGraphControls();
      buildGraph();
      resizeCanvas();
      syncHash();
    });
  });

  document.getElementById("hideOrphans").addEventListener("click", (e) => {
    state.hideOrphans = !state.hideOrphans;
    e.currentTarget.setAttribute("aria-pressed", String(state.hideOrphans));
    buildGraph();
    syncHash();
  });

  document.getElementById("relayout").addEventListener("click", () => {
    // Deterministic scatter onto a ring rather than Math.random(), so pressing this twice
    // on the same node set gives the same picture. It is a reset, not a dice roll.
    G.nodes.forEach((n, i) => {
      const a = (i / Math.max(1, G.nodes.length)) * Math.PI * 2;
      const rad = 120 + (i % 9) * 55;
      n.x = Math.cos(a) * rad * 1.5;
      n.y = Math.sin(a) * rad;
      n.vx = n.vy = 0;
    });
    userMoved = false;
    kick(1);
  });

  wirePointer();
  wireKeyboard();
  syncGraphControls();
}

export function syncGraphControls() {
  const focus = isFocusMode();
  document.querySelectorAll("#graphMode button").forEach((b) =>
    b.setAttribute("aria-pressed", String((b.dataset.g === "all") === !focus)));
  // hide-orphans and re-layout only mean anything for the whole-graph layout.
  document.getElementById("allOnlyTools").classList.toggle("hidden", focus);
  document.getElementById("hideOrphans").setAttribute("aria-pressed", String(state.hideOrphans));
  document.getElementById("focusHint").classList.toggle("hidden", !focus);
  drawLegend();
}

/* The package the focus view is centred on. Falls back to the biggest hub so the view is
   never empty, and follows the drawer so clicking anywhere in the app re-centres it. */
export function focusId() {
  const w = world(state.asof);
  const wanted = state.graphFocus || state.selected;
  if (wanted && w.has(wanted) && !(state.collapseMathlib && wanted === MATHLIB)) return wanted;
  let best = null;
  let bd = -1;
  for (const [id, n] of w)
    if (!(state.collapseMathlib && id === MATHLIB) && n.dependents > bd) { bd = n.dependents; best = id; }
  return best;
}

/* ---------- build ---------- */

export function buildGraph() {
  if (isFocusMode()) buildFocus();
  else buildAll();
}

/* ================= focus mode: a layered DAG around one package ================= */

function buildFocus() {
  const w = world(state.asof);
  const inScope = scopedAt(state.asof);
  const id = focusId();
  const centre = id && w.get(id);
  if (!centre) {
    G = { nodes: [], edges: [], byId: new Map(), hubs: [] };
    document.getElementById("graphNote").textContent = "Nothing to show in this scope.";
    return;
  }

  const mk = (n, kind) => ({
    kind: kind || "pkg", id: n.p.id, name: n.p.name, owner: n.p.owner, k: n.k,
    nameLc: n.p.nameLc, ownerLc: n.p.ownerLc,
    dependents: n.dependents, requires: n.deps.length,
    r: Math.max(6, 2.6 * Math.sqrt(n.dependents)), x: 0, y: 0,
  });

  const node = mk(centre);
  node.focus = true;

  // Requires: what this package stands on. Small for almost everything.
  const requires = centre.deps
    .map((d) => w.get(d))
    .filter((n) => n && inScope.has(n.p.id) && !(state.collapseMathlib && n.p.id === MATHLIB))
    .sort((a, b) => b.dependents - a.dependents)
    .map((n) => mk(n));
  const requiresHidden = centre.deps.length - requires.length;

  // Dependents, split so the pendant mass does not crowd out the packages that matter.
  const allDependents = [];
  for (const [oid, on] of w)
    if (on.deps.includes(id) && !(state.collapseMathlib && oid === MATHLIB)) allDependents.push(on);
  const visible = allDependents.filter((n) => inScope.has(n.p.id));
  const dependentsHidden = allDependents.length - visible.length;

  const isPendant = (n) => n.deps.length === 1 && n.dependents === 0;
  const pendants = visible.filter(isPendant);
  const structural = visible.filter((n) => !isPendant(n))
    .sort((a, b) => b.dependents - a.dependents || a.p.name.localeCompare(b.p.name));

  const aggregatePendants = pendants.length >= MIN_PENDANTS && !expanded.has("pendants");
  const shownDeps = aggregatePendants ? [] : pendants.map((n) => mk(n));
  const overflow = expanded.has("overflow") ? structural : structural.slice(0, ROW_CAP);
  const overflowRest = expanded.has("overflow") ? [] : structural.slice(ROW_CAP);

  const topRow = [...overflow.map((n) => mk(n)), ...shownDeps];
  if (aggregatePendants) {
    topRow.push({
      kind: "agg", id: "agg:pendants", count: pendants.length,
      name: `+${num(pendants.length)} require only ${centre.p.name}`,
      r: 0, x: 0, y: 0, key: "pendants",
    });
  }
  if (overflowRest.length) {
    topRow.push({
      kind: "agg", id: "agg:overflow", count: overflowRest.length,
      name: `+${num(overflowRest.length)} more`, r: 0, x: 0, y: 0, key: "overflow",
    });
  }

  // Lay out: dependents above, focus in the middle, requires below. Arrows point down,
  // so "lower is more foundational" and direction is legible from position alone.
  layoutRow(topRow, -ROW_GAP, -1);
  node.x = 0; node.y = 0;
  layoutRow(requires, ROW_GAP, 1);

  const nodes = [...topRow, node, ...requires];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [
    ...topRow.map((n) => ({ s: n, t: node })),      // dependent requires focus
    ...requires.map((n) => ({ s: node, t: n })),    // focus requires dependency
  ];

  G = { nodes, edges, byId, hubs: [node, ...topRow.filter((n) => n.kind === "pkg")] };
  kbIndex = -1;
  sim.alpha = 0;               // no simulation: the layout is computed, not settled
  if (sim.raf) { cancelAnimationFrame(sim.raf); sim.raf = 0; }
  userMoved = false;           // a new focus is a new picture, so re-fit

  noteFocus(centre, allDependents, pendants,
    { requiresHidden, dependentsHidden, aggregatePendants, overflowRest: overflowRest.length });
  fitCamera();
  draw();
}

/* How much horizontal room a mark needs, including its label.
 *
 * Fixed-width slots do not work here: an aggregate pill is ten times wider than a package
 * dot, and packing both on a constant pitch drew the two pills on top of each other with
 * the wider one's text hidden underneath. */
function itemWidth(n) {
  if (n.kind === "agg") return pillWidth(n) + 16;
  ctx.save();
  ctx.font = "600 11px system-ui, sans-serif";
  const lw = ctx.measureText(n.name).width;
  ctx.restore();
  return Math.max(2 * n.r, lw) + 16;
}

/* Items packed into sub-rows by cumulative width, each sub-row further from the focus. */
function layoutRow(items, yBase, dir) {
  const rows = [];
  let cur = [];
  let w = 0;
  for (const n of items) {
    const iw = itemWidth(n);
    if (cur.length && (w + iw > ROW_MAX_WIDTH || cur.length >= PER_SUBROW)) {
      rows.push(cur); cur = []; w = 0;
    }
    cur.push(n);
    w += iw;
  }
  if (cur.length) rows.push(cur);

  rows.forEach((row, ri) => {
    const total = row.reduce((a, n) => a + itemWidth(n), 0);
    const y = yBase + dir * ri * SUBROW_GAP;
    let x = -total / 2;
    for (const n of row) {
      const iw = itemWidth(n);
      n.x = x + iw / 2;
      n.y = y;
      x += iw;
    }
  });
}

function noteFocus(centre, allDependents, pendants, info) {
  const note = document.getElementById("graphNote");
  note.textContent = "";
  const bits = [
    `${centre.p.name}: ${plural(allDependents.length, "dependent")}, requires ${num(centre.deps.length)}`,
  ];
  if (info.aggregatePendants) bits.push(`${num(pendants.length)} pendants collapsed`);
  if (info.overflowRest) bits.push(`${num(info.overflowRest)} not shown`);
  const hidden = info.requiresHidden + info.dependentsHidden;
  if (hidden) bits.push(`${num(hidden)} out of scope`);
  if (state.collapseMathlib) bits.push("Mathlib hidden");
  note.appendChild(document.createTextNode(bits.join(" · ")));

  if (expanded.size) {
    note.appendChild(document.createTextNode(" · "));
    note.appendChild(noteButton("Collapse", () => { expanded.clear(); buildGraph(); }));
  }
}

/* ================= whole-graph mode: the force layout ================= */

function buildAll() {
  const keep = scopedAt(state.asof);
  let pkgs = [...keep.values()];
  if (state.collapseMathlib) pkgs = pkgs.filter((n) => n.p.id !== MATHLIB);

  const idsAll = new Set(pkgs.map((n) => n.p.id));
  const degree = new Map(pkgs.map((n) => [n.p.id, 0]));
  for (const n of pkgs) {
    for (const d of n.deps) {
      if (idsAll.has(d)) {
        degree.set(n.p.id, degree.get(n.p.id) + 1);
        degree.set(d, degree.get(d) + 1);
      }
    }
  }

  let hiddenOrphans = 0;
  if (state.hideOrphans) {
    const before = pkgs.length;
    pkgs = pkgs.filter((n) => degree.get(n.p.id) > 0);
    hiddenOrphans = before - pkgs.length;
  }
  const ids = new Set(pkgs.map((n) => n.p.id));

  /* Pendant aggregation. A node whose only edge is to a single hub carries no structural
     information of its own, and there are 272 of them on Mathlib alone. Collapsing each
     hub's pendants into one aggregate mark is the single biggest decluttering available,
     and it is not a layout change. */
  const pendantsOf = new Map();
  const collapsed = new Set();
  {
    for (const n of pkgs) {
      const inDeps = n.deps.filter((d) => ids.has(d));
      if (inDeps.length === 1 && n.dependents === 0) {
        const hub = inDeps[0];
        const hubNode = keep.get(hub);
        if (hubNode && isHub(hubNode)) {
          if (!pendantsOf.has(hub)) pendantsOf.set(hub, []);
          pendantsOf.get(hub).push(n);
        }
      }
    }
    for (const [hub, list] of pendantsOf) {
      if (list.length >= MIN_PENDANTS && !expanded.has("all:" + hub)) {
        for (const n of list) collapsed.add(n.p.id);
      } else {
        pendantsOf.delete(hub);
      }
    }
  }

  const old = G.byId;
  const gnodes = [];
  pkgs.forEach((n, i) => {
    if (collapsed.has(n.p.id)) return;
    const prev = old.get(n.p.id);
    const a = (i / Math.max(1, pkgs.length)) * Math.PI * 2;
    gnodes.push({
      kind: "pkg", id: n.p.id, name: n.p.name, owner: n.p.owner, k: n.k,
      nameLc: n.p.nameLc, ownerLc: n.p.ownerLc,
      dependents: n.dependents, requires: n.deps.length,
      shown: n.deps.filter((d) => ids.has(d) && !collapsed.has(d)),
      r: Math.max(2.6, 2.5 * Math.sqrt(n.dependents)),
      x: prev ? prev.x : Math.cos(a) * (180 + (i % 9) * 60) * 1.5,
      y: prev ? prev.y : Math.sin(a) * (180 + (i % 9) * 60),
      vx: 0, vy: 0,
    });
  });
  for (const [hub, list] of pendantsOf) {
    const prev = old.get("agg:" + hub);
    gnodes.push({
      kind: "agg", id: "agg:" + hub, key: "all:" + hub, count: list.length,
      name: `+${num(list.length)}`, hub,
      r: Math.max(7, 2.5 * Math.sqrt(list.length)),
      x: prev ? prev.x : 0, y: prev ? prev.y : 0, vx: 0, vy: 0,
    });
  }

  const byId = new Map(gnodes.map((n) => [n.id, n]));
  const edges = [];
  for (const n of gnodes) {
    if (n.kind === "agg") {
      const t = byId.get(n.hub);
      if (t) edges.push({ s: n, t, weight: n.count });
    } else {
      for (const d of n.shown) { const t = byId.get(d); if (t) edges.push({ s: n, t }); }
    }
  }
  const hubs = gnodes.filter((n) => n.kind === "pkg" && isHub(n))
    .sort((a, b) => b.dependents - a.dependents);

  G = { nodes: gnodes, edges, byId, hubs };
  kbIndex = -1;
  noteAll(keep, hiddenOrphans, collapsed.size, pendantsOf.size);

  const sameSet = old.size === gnodes.length && gnodes.every((n) => old.has(n.id));
  if (!sameSet) userMoved = false;
  kick(sameSet ? 0.25 : 1);
}

function noteAll(keep, hiddenOrphans, collapsedCount, groups) {
  const note = document.getElementById("graphNote");
  note.textContent = "";

  if (state.selected && G.byId.has(state.selected)) {
    // -1 for the selected package itself, which egoOf includes.
    const nb = egoOf().size - 1;
    note.appendChild(document.createTextNode(
      `Showing ${G.byId.get(state.selected).name} and its ${plural(nb, "neighbour")} · `));
    note.appendChild(noteButton("Show all", () => {
      state.selected = null;
      syncHash();
      buildGraph();
    }));
    return;
  }

  const bits = [plural(G.nodes.length, "mark"), plural(G.edges.length, "edge")];
  if (state.collapseMathlib) {
    const m = keep.get(MATHLIB);
    bits.push("Mathlib hidden" + (m ? `, ${num(m.dependents)} edges removed` : ""));
  }
  if (collapsedCount) bits.push(`${num(collapsedCount)} pendants collapsed into ${plural(groups, "mark")}`);
  if (hiddenOrphans) bits.push(`${num(hiddenOrphans)} with no edges hidden`);
  if (state.query) {
    const m = G.nodes.filter((n) => matches(n));
    bits.push(m.length ? `${plural(m.length, "match", "matches")} for “${state.query}”` : `no match for “${state.query}”`);
  }
  note.textContent = bits.join(" · ");
}

function drawLegend() {
  const gl = document.getElementById("graphLegend");
  gl.textContent = "";
  const row = (label, decorate) => {
    const d = tag("div");
    d.style.cssText = "display:flex;align-items:center;margin-top:3px;font-size:12.5px;color:var(--ink2)";
    const sw = tag("span");
    sw.style.cssText = "display:inline-block;width:11px;height:11px;margin-right:8px;flex:none";
    decorate(sw);
    d.append(sw, document.createTextNode(label));
    gl.appendChild(d);
    return d;
  };
  // CLASSES, not Object.values(CLS): dom.js documents that this ORDER is a validated
  // colourblind-safety property, and every other consumer iterates CLASSES.
  CLASSES.forEach((cl) => row(cl.label, (sw) => {
    sw.style.borderRadius = "50%";
    // In the graph only, "requires nothing" is hollow: on a node-link diagram "no fill"
    // reads as "no lines attached", which is what it means.
    if (cl.hollow) sw.style.border = "2px solid " + color(cl.k);
    else sw.style.background = color(cl.k);
  }));
  const sep = row(`Hub — ${HUB_MIN}+ dependents`, (sw) => {
    sw.style.cssText += "border-radius:50%;background:var(--c-mathlib);"
      + "box-shadow:0 0 0 2px var(--surface),0 0 0 3.4px var(--ink)";
  });
  sep.style.cssText += "margin-top:7px;padding-top:7px;border-top:1px solid var(--border)";
  row("Collapsed pendants", (sw) => {
    sw.style.cssText += "border-radius:3px;border:1px dashed var(--muted);background:var(--plane)";
  });
  row(isFocusMode() ? "Arrow points at what is required" : "Edge tapers toward what is required",
    (sw) => { sw.style.cssText += "border-radius:1px;background:var(--axis);height:2px"; });
}

/* ---------- simulation (whole-graph mode only) ---------- */

function kick(alpha) {
  if (isFocusMode()) return;
  sim.alpha = Math.max(sim.alpha, alpha);
  if (REDUCED.matches) { settle(); return; }
  if (!sim.raf) sim.raf = requestAnimationFrame(tick);
}

function settle() {
  let guard = 400;
  while (sim.alpha > 0.02 && guard-- > 0) step();
  sim.alpha = 0;
  fitCamera();
  draw();
}

/* Spatial hash for the neighbour scans. Rebuilt per pass on purpose, because positions
   move between passes; it was the six lines of bucketing that were duplicated, not the
   rebuild itself. The cell-key format lived in five places. */
const cellKey = (x, y, cell) => ((x / cell) | 0) + "," + ((y / cell) | 0);

function buildGrid(nodes, cell) {
  const grid = new Map();
  for (const n of nodes) {
    const key = cellKey(n.x, n.y, cell);
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(n);
  }
  return grid;
}

function step() {
  const N = G.nodes;
  const E = G.edges;
  const cell = 70;

  const grid = buildGrid(N, cell);
  for (const n of N) {
    const gx = (n.x / cell) | 0;
    const gy = (n.y / cell) | 0;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const b = grid.get((gx + i) + "," + (gy + j));
        if (!b) continue;
        for (const m of b) {
          if (m === n) continue;
          let dx = n.x - m.x;
          let dy = n.y - m.y;
          let d2 = dx * dx + dy * dy;
          if (d2 === 0) { dx = (n.r - m.r) || 0.5; dy = 0.5; d2 = 0.5; }
          if (d2 > cell * cell * 4) continue;
          const d = Math.sqrt(d2);
          const f = Math.min(26, (1500 + n.r * m.r * 30) / d2);
          n.vx += (dx / d) * f * 0.3;
          n.vy += (dy / d) * f * 0.3;
        }
      }
    }
  }
  for (const e of E) {
    const dx = e.t.x - e.s.x;
    const dy = e.t.y - e.s.y;
    const d = Math.max(1, Math.hypot(dx, dy));
    const target = 92 + e.t.r * 2.2 + e.s.r * 2.2;
    const f = (d - target) * 0.016;
    e.s.vx += (dx / d) * f; e.s.vy += (dy / d) * f;
    e.t.vx -= (dx / d) * f; e.t.vy -= (dy / d) * f;
  }
  for (const n of N) {
    n.vx -= n.x * 0.0009;
    n.vy -= n.y * 0.0016;
    if (n === dragNode) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.84; n.vy *= 0.84;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > 30) { n.vx = (n.vx / sp) * 30; n.vy = (n.vy / sp) * 30; }
    n.x += n.vx * sim.alpha;
    n.y += n.vy * sim.alpha;
  }
  /* Hard separation. The forces alone do not resolve it: the leaves hanging off Mathlib
     squeeze the second-tier hubs inside its disc, hiding exactly what the reader came for. */
  for (let pass = 0; pass < 2; pass++) {
    const g2 = buildGrid(N, cell);
    for (const n of N) {
      const gx = (n.x / cell) | 0;
      const gy = (n.y / cell) | 0;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const b = g2.get((gx + i) + "," + (gy + j));
          if (!b) continue;
          for (const m of b) {
            if (m === n || m === dragNode) continue;
            const dx = m.x - n.x;
            const dy = (m.y - n.y) * 1.7;
            const min = n.r + m.r + 5;
            const d = Math.hypot(dx, dy) || 0.01;
            if (d < min) {
              const push = ((min - d) / d) * 0.5;
              if (n !== dragNode) { n.x -= dx * push; n.y -= dy * push; }
              m.x += dx * push; m.y += dy * push;
            }
          }
        }
      }
    }
  }
  sim.alpha *= 0.992;
}

function tick() {
  step();
  fitCamera();
  draw();
  sim.raf = (sim.alpha > 0.02 || dragNode) ? requestAnimationFrame(tick) : 0;
}

/* ---------- camera ---------- */

function bounds() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const n of G.nodes) {
    const w = n.kind === "agg" ? pillWidth(n) / 2 : n.r;
    const h = aggHalfH(n);
    // Labels alternate above and below a row, so reserve label height on both sides.
    const lab = n.kind === "pkg" ? 22 : 4;
    x0 = Math.min(x0, n.x - w); x1 = Math.max(x1, n.x + w);
    y0 = Math.min(y0, n.y - h - lab); y1 = Math.max(y1, n.y + h + lab);
  }
  return { x0, y0, x1, y1 };
}

function fitCamera() {
  if (userMoved || !G.nodes.length) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const b = bounds();
  const bw = Math.max(1, b.x1 - b.x0);
  const bh = Math.max(1, b.y1 - b.y0);
  const pad = isFocusMode() ? 60 : 70;
  cam.k = Math.max(0.2, Math.min(isFocusMode() ? 1.4 : 2.4,
    Math.min((r.width - pad) / bw, (r.height - pad) / bh)));
  cam.x = -((b.x0 + b.x1) / 2) * cam.k;
  cam.y = -((b.y0 + b.y1) / 2) * cam.k;
}

function centerOn(n, k) {
  userMoved = true;
  cam.k = k || Math.max(cam.k, 1.5);
  cam.x = -n.x * cam.k;
  cam.y = -n.y * cam.k;
  draw();
}

export function resizeCanvas() {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  if (!r.width) return;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fitCamera();
  draw();
}

export function reheat() {
  resizeCanvas();
  if (!isFocusMode()) kick(0.6);
}

/* ---------- draw ---------- */

const pillWidth = (n) => {
  ctx.save();
  ctx.font = "600 12px system-ui, sans-serif";
  const w = ctx.measureText(n.name).width + 20;
  ctx.restore();
  return w;
};

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

export function draw() {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;

  // Colours are read from CSS custom properties every frame, not cached: a canvas that
  // cached them at first paint silently stays light after a theme change.
  const surf = cssv("--surface");
  const ink = cssv("--ink");
  const axis = cssv("--axis");
  const muted = cssv("--muted");
  // The four class colours were read via getComputedStyle inside the per-node loop: 672
  // lookups a frame, ~327,000 over a force settle, for four constant values. draw() already
  // hoisted the tokens above; these were left behind.
  const pal = Object.fromEntries(Object.keys(CLS).map((k) => [k, color(k)]));
  const sel = cssv("--c-mathlib");

  ctx.save();
  ctx.clearRect(0, 0, r.width, r.height);
  ctx.translate(r.width / 2 + cam.x, r.height / 2 + cam.y);
  ctx.scale(cam.k, cam.k);

  if (isFocusMode()) drawFocusEdges(ink, muted);
  else drawAllEdges(axis, ink);

  const ego = isFocusMode() ? null : egoOf();

  for (const n of G.nodes) {
    const dim = (state.query && !matches(n) && n.kind === "pkg") || (ego && !ego.has(n.id));
    ctx.globalAlpha = dim ? 0.15 : 1;
    if (n.kind === "agg") drawPill(n, surf, muted, ink, sel);
    else drawNode(n, surf, ink, pal, sel);
    ctx.globalAlpha = 1;
  }

  drawLabels(surf, ink, ego);
  ctx.restore();
}

function drawNode(n, surf, ink, pal, sel) {
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r, 0, 6.2832);
  if (CLS[n.k].hollow) {
    ctx.fillStyle = surf; ctx.fill();
    ctx.strokeStyle = pal[n.k]; ctx.lineWidth = 1.5 / cam.k; ctx.stroke();
  } else {
    ctx.fillStyle = pal[n.k]; ctx.fill();
    ctx.strokeStyle = surf; ctx.lineWidth = 2 / cam.k; ctx.stroke();
  }
  // Hub-ness is INCOMING importance, so it gets its own channel and cannot be mistaken
  // for the class fill, which is outgoing.
  if (isHub(n)) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + 2.5 / cam.k, 0, 6.2832);
    ctx.strokeStyle = ink;
    ctx.globalAlpha *= 0.75;
    ctx.lineWidth = 1.6 / cam.k;
    ctx.stroke();
    ctx.globalAlpha /= 0.75;
  }
  const lit = n === hoverNode || n.focus || (state.selected && n.id === state.selected);
  if (lit) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + 6 / cam.k, 0, 6.2832);
    ctx.strokeStyle = sel;
    ctx.lineWidth = 2.6 / cam.k;
    ctx.stroke();
  }
}

/* An aggregate is not a package, so it must not look like one. Dashed outline, no class
   colour, and the count as its label. */
function drawPill(n, surf, muted, ink, sel) {
  const w = pillWidth(n);
  const h = PILL_H;
  roundRect(n.x - w / 2, n.y - h / 2, w, h, 7);
  ctx.fillStyle = surf;
  ctx.fill();
  ctx.setLineDash([4 / cam.k, 3 / cam.k]);
  ctx.strokeStyle = n === hoverNode ? sel : muted;
  ctx.lineWidth = 1.4 / cam.k;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ink;
  ctx.fillText(n.name, n.x, n.y + 0.5);
}

/* Focus mode: an explicit arrow per edge, pointing at what is required. Direction is also
   readable from position alone (lower is more foundational), so the arrow confirms rather
   than carries it. */
function drawFocusEdges(ink, muted) {
  ctx.lineWidth = 1.4 / cam.k;
  for (const e of G.edges) {
    const lit = hoverNode && (e.s === hoverNode || e.t === hoverNode);
    ctx.strokeStyle = lit ? ink : muted;
    ctx.globalAlpha = lit ? 0.9 : 0.5;
    const sr = aggHalfH(e.s);
    const tr = aggHalfH(e.t);
    const dx = e.t.x - e.s.x;
    const dy = e.t.y - e.s.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const x0 = e.s.x + ux * (sr + 2);
    const y0 = e.s.y + uy * (sr + 2);
    const head = 9 / cam.k;
    const x1 = e.t.x - ux * (tr + 3 + head);
    const y1 = e.t.y - uy * (tr + 3 + head);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // arrowhead
    const ax = e.t.x - ux * (tr + 3);
    const ay = e.t.y - uy * (tr + 3);
    const wing = 4.2 / cam.k;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - ux * head - uy * wing, ay - uy * head + ux * wing);
    ctx.lineTo(ax - ux * head + uy * wing, ay - uy * head - ux * wing);
    ctx.closePath();
    ctx.fillStyle = lit ? ink : muted;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* Whole-graph mode: 1,010 arrowheads at this density is illegible noise, so direction is
   carried by tapering instead. Each edge is a thin triangle, wide at the dependent and
   narrow at the dependency it requires. */
function drawAllEdges(axis, ink) {
  ctx.globalAlpha = 0.38;
  ctx.fillStyle = axis;
  for (const e of G.edges) {
    if (hoverNode && (e.s === hoverNode || e.t === hoverNode)) continue;
    taper(e, 2.2 / cam.k);
  }
  if (hoverNode) {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = ink;
    for (const e of G.edges) {
      if (e.s === hoverNode || e.t === hoverNode) taper(e, 3.4 / cam.k);
    }
  }
  ctx.globalAlpha = 1;
}

function taper(e, wide) {
  const dx = e.t.x - e.s.x;
  const dy = e.t.y - e.s.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = -dy / d;
  const ny = dx / d;
  const h = wide / 2;
  ctx.beginPath();
  ctx.moveTo(e.s.x + nx * h, e.s.y + ny * h);
  ctx.lineTo(e.s.x - nx * h, e.s.y - ny * h);
  ctx.lineTo(e.t.x, e.t.y);
  ctx.closePath();
  ctx.fill();
}

function drawLabels(surf, ink, ego) {
  ctx.font = "600 " + (11 / cam.k).toFixed(2) + "px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const pad = 3 / cam.k;
  const lh = 13 / cam.k;
  const gap = 6 / cam.k;

  const hit = (a, b) => !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);
  const label = (n, ly) => {
    ctx.lineWidth = 3 / cam.k;
    ctx.strokeStyle = surf;
    ctx.strokeText(n.name, n.x, ly);
    ctx.fillStyle = ink;
    ctx.fillText(n.name, n.x, ly);
  };

  // Focus mode has at most ~33 marks, so everything gets a name. Alternate above and
  // below within a sub-row so neighbouring labels cannot collide.
  if (isFocusMode()) {
    const byRow = new Map();
    for (const n of G.nodes) {
      if (n.kind === "agg") continue;
      if (!byRow.has(n.y)) byRow.set(n.y, []);
      byRow.get(n.y).push(n);
    }
    for (const [, row] of byRow) {
      row.sort((a, b) => a.x - b.x);
      row.forEach((n, i) => {
        const above = n.focus ? false : i % 2 === 0;
        label(n, above ? n.y - n.r - gap : n.y + n.r + gap + lh);
      });
    }
    return;
  }

  /* Whole-graph mode: deterministic priority so the same picture always drops the same
     labels, rather than "whichever fits first this frame". */
  const bigNodes = G.nodes.filter((n) => n.r >= 7);
  const placed = [];
  const overlaps = (box, self) => placed.some((b) => hit(box, b))
    || bigNodes.some((b) => b !== self && hit(box, { x0: b.x - b.r, x1: b.x + b.r, y0: b.y - b.r, y1: b.y + b.r }));

  const egoCands = ego
    ? G.nodes.filter((n) => ego.has(n.id) && n.kind === "pkg").sort((a, b) => b.dependents - a.dependents).slice(0, 12)
    : [];
  const searchCands = G.nodes.filter((n) => matches(n)).sort((a, b) => b.dependents - a.dependents);
  const cands = [...egoCands, ...searchCands, ...G.hubs].slice(0, 24);

  const done = new Set();
  for (const n of cands) {
    if (done.has(n.id)) continue;
    done.add(n.id);
    const w = ctx.measureText(n.name).width;
    for (const ly of [n.y - n.r - gap, n.y + n.r + gap + lh, n.y + lh / 3]) {
      const box = { x0: n.x - w / 2 - pad, x1: n.x + w / 2 + pad, y0: ly - lh, y1: ly + pad };
      if (!overlaps(box, n)) { placed.push(box); label(n, ly); break; }
    }
  }
}

/* ---------- interaction ---------- */

function nodeAt(cx, cy) {
  const r = canvas.getBoundingClientRect();
  const x = (cx - r.left - r.width / 2 - cam.x) / cam.k;
  const y = (cy - r.top - r.height / 2 - cam.y) / cam.k;
  let best = null;
  let bd = 1e9;
  for (const n of G.nodes) {
    if (n.kind === "agg") {
      const w = pillWidth(n) / 2;
      if (Math.abs(x - n.x) < w && Math.abs(y - n.y) < aggHalfH(n) + 2) return n;
      continue;
    }
    const d = Math.hypot(n.x - x, n.y - y);
    // Hit target larger than the mark: an 8px node is a pinpoint nobody lands on.
    const reach = Math.max(n.r + 6 / cam.k, 12 / cam.k);
    if (d < reach && d < bd) { best = n; bd = d; }
  }
  return best;
}

function activate(n) {
  if (n.kind === "agg") {
    // Aggregates are not dead ends: opening one shows what it stands for.
    expanded.add(n.key);
    buildGraph();
    if (!isFocusMode()) resizeCanvas();
    return;
  }
  if (isFocusMode()) state.graphFocus = n.id;
  onOpen(n.id);
}

function wirePointer() {
  canvas.addEventListener("pointermove", (e) => {
    if (panning && last) {
      userMoved = true;
      cam.x += e.clientX - last.x;
      cam.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      draw();
      return;
    }
    if (dragNode) {
      if (downPt) dragTravel += Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y);
      downPt = { x: e.clientX, y: e.clientY };
      const r = canvas.getBoundingClientRect();
      dragNode.x = (e.clientX - r.left - r.width / 2 - cam.x) / cam.k;
      dragNode.y = (e.clientY - r.top - r.height / 2 - cam.y) / cam.k;
      userMoved = true;
      if (isFocusMode() || REDUCED.matches) draw();
      else kick(0.35);
      return;
    }
    const n = nodeAt(e.clientX, e.clientY);
    if (n !== hoverNode) { hoverNode = n; draw(); }
    if (!n) { hideTip(); return; }
    if (n.kind === "agg") {
      showTip(e.clientX, e.clientY, n.name, [
        { value: num(n.count), name: "packages, collapsed into one mark" },
        { value: "click", name: "to show them individually" },
      ]);
    } else {
      showTip(e.clientX, e.clientY, n.id, [
        { value: num(n.dependents), name: "packages depend on it", color: color(n.k) },
        { value: num(n.requires), name: "packages it requires" },
        { value: CLS[n.k].label, name: "class" },
      ]);
    }
  });

  canvas.addEventListener("pointerdown", (e) => {
    const n = nodeAt(e.clientX, e.clientY);
    downPt = { x: e.clientX, y: e.clientY };
    dragTravel = 0;
    if (n) dragNode = n;
    else { panning = true; last = { x: e.clientX, y: e.clientY }; canvas.classList.add("drag"); }
  });

  /* A click activates; a drag does not. An early build called nodeAt() on pointerup, which
     always returned the dragged node, so every attempt to untangle the layout fired a
     modal over a third of the canvas. */
  addEventListener("pointerup", () => {
    if (dragNode && dragTravel < 5) activate(dragNode);
    dragNode = null;
    downPt = null;
    panning = false;
    last = null;
    canvas.classList.remove("drag");
    if (!isFocusMode() && !sim.raf && sim.alpha > 0.02) kick(sim.alpha);
  });

  canvas.addEventListener("pointerleave", () => { hoverNode = null; hideTip(); draw(); });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    userMoved = true;
    cam.k = Math.max(0.2, Math.min(4, cam.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    draw();
  }, { passive: false });
}

/* A node-link diagram will never be fully accessible; the honest answer is an equivalent
   non-visual path (All packages) plus a real keyboard story here. */
function wireKeyboard() {
  canvas.addEventListener("keydown", (e) => {
    const list = isFocusMode() ? G.nodes.filter((n) => n.kind === "pkg") : G.hubs;
    if (!list.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      kbIndex = (kbIndex + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length;
      const n = list[kbIndex];
      hoverNode = n;
      if (isFocusMode()) draw();
      else centerOn(n, Math.max(cam.k, 1.2));
      const where = n.focus ? "focus" : n.y < 0 ? "depends on it" : "required by it";
      say(`${n.id}, ${plural(n.dependents, "dependent")}, ${CLS[n.k].label}`
        + (isFocusMode() ? `, ${where}` : ""));
    } else if ((e.key === "Enter" || e.key === " ") && kbIndex >= 0) {
      e.preventDefault();
      activate(list[kbIndex]);
    }
  });
}
