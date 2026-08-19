/* Reservoir Stats — boot, the single render entry point, and all event wiring. */

import {
  CLASSES, color, num, pct, plural, say, tag,
} from "./dom.js";
import {
  drawComposition, drawCompSummary, drawLegend, drawMix, drawTop, lineChart,
} from "./charts.js";
import { hideDrawer, initDrawer, isOpen, renderDrawer, setLayoutChangeHandler, showDrawer } from "./drawer.js";
import { pushHash, readHash, setMonthCount, state, syncHash } from "./state.js";
import { buildGraph, draw as drawGraph, initGraph, reheat, resizeCanvas, syncGraphControls } from "./graph.js";
import { drawAllTable } from "./table.js";
import {
  BY_ID, counts, growth, init, MATHLIB, matchesQuery, meta, mixSeries, MONTHS, NM,
  PALOMAR_N, PKGS, prevYear, rollup, scopedAt, world,
} from "./world.js";

const $ = (id) => document.getElementById(id);
const TOP_N = 13;

/* ================= boot ================= */

async function boot() {
  const bootEl = $("boot");
  let data;
  try {
    const res = await fetch("data/summary.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    data = await res.json();
  } catch (err) {
    bootEl.className = "err";
    bootEl.textContent = `Could not load the registry data (${err.message}). `
      + "If you are running this locally, the data file is built by reservoir_stats.py.";
    return;
  }

  init(data);
  setMonthCount(NM);
  state.asof = NM - 1;
  const wanted = readHash();

  bootEl.remove();
  $("app").classList.remove("hidden");

  buildChips();
  // A build whose Palomar fetch failed, or a feed naming no indexed package, leaves a
  // chip whose only possible effect is to empty every view. Drop the control instead,
  // and drop the state a deep link may have set with it.
  if (!PALOMAR_N) {
    state.palomarOnly = false;
    $("palomarFilter").classList.add("hidden");
  }
  wireControls();
  initDrawer({ navigate: openPackage, close: closePackage });
  initGraph({ open: openPackage });
  // Docking the panel changes the page's usable width without firing a resize event, and
  // charts size from their container.
  setLayoutChangeHandler(() => {
    if (state.view === "graph") resizeCanvas();
    else render();
  });

  $("asof").max = NM - 1;
  syncControls();

  renderFooter();
  setView(state.view, { push: false });
  render();
  if (wanted && BY_ID.has(wanted)) openPackage(wanted, { push: false });
}

function renderFooter() {
  const d = meta();
  const when = new Date(d.generatedAt);
  const stamp = isNaN(when) ? d.generatedAt : when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  $("footGen").textContent =
    `${num(PKGS.length)} packages, ${MONTHS[0]} to ${MONTHS[NM - 1]}. Data generated ${stamp} from the Reservoir index.`;
  $("footNow").textContent = num(PKGS.length);
}

/* ================= render ================= */

let rendering = false;

export function render() {
  if (rendering) return;
  rendering = true;
  try {
    const keep = scopedAt(state.asof);
    const c = counts(keep);
    const total = keep.size;
    const w = world(state.asof);

    const roll = rollup(keep);
    renderScopeBar(keep, w, total);
    renderKpis(keep, c, total, roll);

    drawComposition($("compChart"), c, total);
    drawCompSummary($("compSummary"), c, total, roll);
    drawLegend($("compLegend"), c);

    const series = mixSeries();
    drawMix($("mixChart"), series);
    drawLegend($("mixLegend"));

    renderRanking(keep, w);

    lineChart($("ecoN"), { values: series.map((r) => r.tot), months: series.map((r) => r.t), name: "packages" });
    lineChart($("ecoE"), { values: series.map((r) => r.edges), months: series.map((r) => r.t), name: "edges" });

    /* Build only what is on screen. The table is 808 rows of 9 cells with two listeners
       each, and #view-table is display:none in two of the three views. Rebuilding it
       anyway cost ~8,900 elements and ~1,600 listener registrations per render, and the
       month slider fires one render per step, so a single drag across 34 months built and
       discarded roughly 300,000 elements. The graph was already gated this way. */
    if (state.view === "table") renderTable(keep);
    else tableDirty = true;
    if (state.view === "graph") buildGraph();

    syncChips();
    syncHash();
  } finally {
    rendering = false;
  }
}

/* The table is rebuilt on reveal rather than on every render, so it has to remember that
   the data moved underneath it while it was hidden. */
let tableDirty = true;

function renderTable(keep = scopedAt(state.asof)) {
  drawAllTable($("allTable"), keep, openPackage, render);
  tableDirty = false;
}

/* The scope bar. If this and what's on screen disagree, that is a P0 bug: it is the
   app's contract with the reader about whether the numbers can be trusted. */
function renderScopeBar(keep, w, total) {
  const sb = $("scopebar");
  sb.textContent = "";
  const strong = tag("b", "", `${num(total)} of ${num(w.size)} packages`);
  const parts = [` in scope as of ${MONTHS[state.asof]}.`];
  if (state.query) {
    const m = [...keep.values()].filter((n) => matchesQuery(n.p)).length;
    const where = state.view === "graph"
      ? "the graph dims everything else"
      : "the charts above are not";
    parts.push(` The table is filtered to ${plural(m, "match", "matches")} for “${state.query}”; ${where}.`);
  }
  if (state.view === "graph" && state.hideOrphans) {
    parts.push(" The graph hides packages with no edges — use the toggle to show them.");
  }
  if (state.palomarOnly) {
    // Absence in this feed is not absence from Palomar, and a scope bar that let a reader
    // believe otherwise would be the same class of lie as the filtered-then-counted bug.
    // Deliberately no count of its own: the bold prefix already states how many packages
    // survive every filter, and a second number here would read as disagreeing with it.
    parts.push(" Limited to packages with an entry in Palomar's recent-registrations feed."
      + " That feed is not the whole registry, so a package missing here may still be on"
      + " Palomar.");
  }
  if (state.collapseMathlib) {
    parts.push(state.view === "graph"
      ? " Mathlib is excluded from the graph and the ranking."
      : " Mathlib is excluded from the ranking.");
  }
  parts.push(" Dependency counts are always measured against the full graph, so filters change what you see, never what the numbers mean.");
  sb.append(strong, document.createTextNode(parts.join("")));
}

function renderKpis(keep, c, total, roll) {
  const prevT = prevYear();
  const prev = prevT === null ? 0 : scopedAt(prevT).size;

  $("kPkgs").textContent = num(total);
  const ps = $("kPkgsSub");
  ps.textContent = "";
  if (prev) {
    const change = Math.round((total / prev - 1) * 100);
    const d = tag("span", change < 0 ? "delta down" : "delta", (change >= 0 ? "+" : "") + change + "%");
    ps.append(d, document.createTextNode(" vs " + MONTHS[prevT]));
  } else {
    ps.textContent = "as of " + MONTHS[state.asof];
  }

  $("kEdges").textContent = num(roll.edges);
  $("kEdgesSub").textContent = (total ? (roll.edges / total).toFixed(2) : "0") + " per package";

  const ml = c.mathlib + c.mathlibplus;
  $("kMathlib").textContent = pct(roll.transitive, total) + "%";
  $("kMathlibSub").textContent =
    `${pct(ml, total)}% directly · ${pct(roll.transitive - ml, total)}% only through something else`;

  $("kNone").textContent = pct(c.none, total) + "%";
  $("kNoneSub").textContent = plural(c.none, "package");
}

function renderRanking(keep, w) {
  const prevT = prevYear();
  // Collapse Mathlib removes it from the ranking only — never from the counts, which is
  // why this filters the display pool rather than the world.
  const pool = [...keep.values()].filter((n) => !(state.collapseMathlib && n.p.id === MATHLIB));
  const rows = pool.map((n) => ({
    id: n.p.id,
    name: n.p.name,
    owner: n.p.owner,
    k: n.k,
    total: n.dependents,
    growth: growth(n.p.id),
    share: pct(n.dependents, w.size),
    stars: n.p.stars,
  }));
  rows.forEach((r) => { r.v = state.topMetric === "used" ? r.total : r.growth; });
  const ranked = rows.filter((r) => r.v > 0).sort((a, b) => b.v - a.v || b.total - a.total).slice(0, TOP_N);

  $("topTitle").textContent = state.topMetric === "used" ? "Most depended-on packages" : "Fastest growing packages";
  $("topCap").textContent = state.topMetric === "used"
    ? "Direct dependents, counted across the whole graph — not just the packages in scope."
    : `New dependents gained since ${MONTHS[prevT === null ? 0 : prevT]}.`;
  drawTop($("topCallout"), $("topChart"), ranked, state.topMetric, openPackage);
}

/* ================= drawer ================= */

function openPackage(id, opts = {}) {
  if (!renderDrawer(id)) return;
  state.selected = id;
  if (state.graphMode !== "all") state.graphFocus = id;
  showDrawer();
  if (state.view === "graph") { buildGraph(); drawGraph(); }
  // The drawer is in the URL, so opening it earns a history entry: a reader pressing
  // Back to dismiss it should get the page back, not leave the site.
  if (opts.push === false) syncHash();
  else pushHash();
}

function closePackage(opts = {}) {
  if (!isOpen()) return;
  state.selected = null;
  hideDrawer();
  if (state.view === "graph") { buildGraph(); drawGraph(); }
  if (opts.fromHistory) syncHash();
  else pushHash();
}

/* ================= views ================= */

const VIEWS = { overview: "view-overview", graph: "view-graph", table: "view-table" };

function setView(v, opts = {}) {
  state.view = v in VIEWS ? v : "overview";
  Object.entries(VIEWS).forEach(([k, id]) => {
    $(id).classList.toggle("hidden", k !== state.view);
    $("tab-" + k).setAttribute("aria-selected", String(k === state.view));
  });
  // The canvas has no size until its panel is visible, so it can only be measured here.
  // buildGraph first: render() only builds when the graph is already the active view, so
  // arriving at the tab for the first time would otherwise reheat an empty node set and
  // paint nothing.
  if (state.view === "graph") { buildGraph(); reheat(); }
  if (state.view === "table" && tableDirty) renderTable();
  if (opts.push === false) syncHash();
  else pushHash();
}

/* ================= controls ================= */

function buildChips() {
  const chips = $("clschips");
  CLASSES.forEach((cl) => {
    const b = tag("button", "chip cls");
    b.type = "button";
    b.dataset.k = cl.k;
    const sw = tag("span", "sw");
    sw.style.background = color(cl.k);
    b.append(sw, document.createTextNode(cl.short));
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") === "true";
      // Refuse rather than silently do nothing, and say why.
      if (on && state.classes.size === 1) {
        say("At least one dependency class must stay selected.");
        return;
      }
      if (on) state.classes.delete(cl.k);
      else state.classes.add(cl.k);
      render();
    });
    chips.appendChild(b);
  });
}

function syncChips() {
  $("clschips").querySelectorAll("button").forEach((b) => {
    const on = state.classes.has(b.dataset.k);
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-disabled", String(on && state.classes.size === 1));
  });
}

/* Push every piece of state back into the controls.
 *
 * Used by both boot and back/forward, because they are the same problem: state arrived
 * from the URL rather than from a click, so no control knows about it yet. A deep link
 * with `r=growth` rendered the growth ranking under a "Most used" button that still
 * looked pressed until this was shared. */
function syncControls() {
  $("asof").value = state.asof;
  $("asofLab").textContent = MONTHS[state.asof];
  // Without aria-valuetext, assistive tech announces "25 of 33" instead of a date.
  $("asof").setAttribute("aria-valuetext", MONTHS[state.asof]);
  $("minstars").value = String(state.minStars);
  $("collapseMathlib").setAttribute("aria-pressed", String(state.collapseMathlib));
  $("palomarOnly").setAttribute("aria-pressed", String(state.palomarOnly));
  syncGraphControls();
  $("find").value = state.query;
  document.querySelectorAll("#topMetric button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.m === state.topMetric)));
  syncChips();
}

function setAsof(v) {
  state.asof = +v;
  const asof = $("asof");
  asof.value = state.asof;
  $("asofLab").textContent = MONTHS[state.asof];
  asof.setAttribute("aria-valuetext", MONTHS[state.asof]);
  render();
  // The drawer's own numbers are as-of-dependent, so it has to follow the slider.
  if (state.selected && isOpen()) renderDrawer(state.selected);
}

function wireControls() {
  $("asof").addEventListener("input", (e) => setAsof(e.target.value));

  $("minstars").addEventListener("change", (e) => {
    state.minStars = +e.target.value;
    render();
  });

  $("collapseMathlib").addEventListener("click", (e) => {
    state.collapseMathlib = !state.collapseMathlib;
    e.currentTarget.setAttribute("aria-pressed", String(state.collapseMathlib));
    render();
  });

  $("palomarOnly").addEventListener("click", (e) => {
    state.palomarOnly = !state.palomarOnly;
    e.currentTarget.setAttribute("aria-pressed", String(state.palomarOnly));
    render();
  });

  const seg = (id, key, attr) => {
    document.querySelectorAll(`#${id} button`).forEach((b) => {
      b.addEventListener("click", () => {
        state[key] = b.dataset[attr];
        document.querySelectorAll(`#${id} button`).forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
        render();
      });
    });
  };
  seg("compForm", "compForm", "f");
  seg("mixForm", "mixForm", "f");
  seg("topForm", "topForm", "f");
  seg("topMetric", "topMetric", "m");

  Object.keys(VIEWS).forEach((v) => $("tab-" + v).addEventListener("click", () => setView(v)));

  wireFind();
  wireTheme();

  // Charts size from their container, so a resize that doesn't re-render leaves them
  // at the wrong width.
  let rzT = 0;
  addEventListener("resize", () => {
    clearTimeout(rzT);
    rzT = setTimeout(() => {
      render();
      if (state.view === "graph") resizeCanvas();
    }, 150);
  });

  // Back/forward, including Back to close the drawer.
  addEventListener("hashchange", () => {
    const wanted = readHash();
    syncControls();
    setView(state.view, { push: false });
    render();
    if (wanted && BY_ID.has(wanted)) {
      if (state.selected !== wanted || !isOpen()) openPackage(wanted, { push: false });
    } else if (isOpen()) {
      closePackage({ fromHistory: true });
    }
  });
}

/* One search box. It is a finder, not a filter of the Overview: "SciLean" is not a
   meaningful ecosystem scope, so it deliberately does not recompute the KPIs. It offers
   an autocomplete that opens a package, and it filters the table. The scope bar states
   exactly that, because the same control doing two things is otherwise a trap. */
function wireFind() {
  const find = $("find");
  let auto = null;
  let autoIdx = -1;
  let findT = 0;

  const closeAuto = () => {
    if (auto) { auto.remove(); auto = null; }
    autoIdx = -1;
    find.setAttribute("aria-expanded", "false");
    find.removeAttribute("aria-activedescendant");
  };

  const markAuto = () => {
    if (!auto) return;
    [...auto.children].forEach((b, i) => {
      const on = i === autoIdx;
      b.setAttribute("aria-selected", String(on));
      b.style.background = on ? "var(--ghost)" : "transparent";
      if (on) {
        find.setAttribute("aria-activedescendant", b.id);
        b.scrollIntoView({ block: "nearest" });
      }
    });
  };

  const openAuto = () => {
    closeAuto();
    if (state.query.length < 2) return;
    const hits = PKGS.filter((p) => p.firstMonth <= state.asof && matchesQuery(p)).slice(0, 12);
    if (!hits.length) return;
    auto = tag("div", "autolist");
    auto.id = "findList";
    auto.setAttribute("role", "listbox");
    auto.style.top = "34px";
    auto.style.left = "0";
    hits.forEach((p, i) => {
      const b = tag("button");
      b.type = "button";
      b.id = "findOpt" + i;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", "false");
      b.tabIndex = -1;
      b.append(tag("span", "", p.name), tag("span", "o", "  @" + p.owner));
      b.addEventListener("mousedown", (e) => e.preventDefault());   // don't blur before click
      b.addEventListener("click", () => {
        const id = p.id;
        closeAuto();
        openPackage(id);
      });
      auto.appendChild(b);
    });
    find.parentNode.appendChild(auto);
    find.setAttribute("aria-expanded", "true");
  };

  find.addEventListener("input", () => {
    state.query = find.value.trim().toLowerCase();
    openAuto();
    clearTimeout(findT);
    findT = setTimeout(render, 200);
  });

  find.addEventListener("keydown", (e) => {
    if (!auto) {
      if (e.key === "ArrowDown") {
        openAuto();
        if (auto) { autoIdx = 0; markAuto(); e.preventDefault(); }
      }
      return;
    }
    const n = auto.children.length;
    if (e.key === "ArrowDown") { e.preventDefault(); autoIdx = (autoIdx + 1) % n; markAuto(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); autoIdx = (autoIdx - 1 + n) % n; markAuto(); }
    else if (e.key === "Enter" && autoIdx >= 0) { e.preventDefault(); auto.children[autoIdx].click(); }
    else if (e.key === "Escape") { e.preventDefault(); closeAuto(); }
  });

  find.addEventListener("blur", () => setTimeout(() => {
    if (auto && auto.contains(document.activeElement)) return;
    closeAuto();
  }, 160));
}

/* An explicit choice beats the OS setting in both directions — see tokens.css. */
function wireTheme() {
  const btn = $("themeBtn");
  const dark = () => document.documentElement.getAttribute("data-theme") === "dark"
    || (!document.documentElement.hasAttribute("data-theme")
      && matchMedia("(prefers-color-scheme: dark)").matches);
  btn.textContent = dark() ? "Light" : "Dark";
  btn.addEventListener("click", () => {
    const next = dark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    btn.textContent = next === "dark" ? "Light" : "Dark";
    // Charts read their colours from CSS custom properties at draw time, so they need
    // redrawing rather than restyling.
    render();
    if (state.view === "graph") drawGraph();
    if (state.selected && isOpen()) renderDrawer(state.selected);
  });
}

boot();
