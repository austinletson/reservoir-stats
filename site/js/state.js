/* Application state and its serialisation to the URL hash.
 *
 * No localStorage or sessionStorage anywhere: in-memory state plus the hash. That keeps
 * a view shareable and keeps the page embeddable.
 */

import { CLASSES, CLS } from "./dom.js";

export const state = {
  view: "overview",
  asof: 0,          // set to the latest month once the data loads
  minStars: 0,
  classes: new Set(CLASSES.map((c) => c.k)),
  collapseMathlib: false,
  /* Restrict scope to packages carrying a Palomar registry entry. A scope filter like
     min stars, not a display toggle like Hide Mathlib: it goes through inScope, so
     dependent counts stay measured over the whole graph. */
  palomarOnly: false,
  /* Restrict scope to packages carrying a formalization.yaml. A scope filter for the same
     reason palomarOnly is one, and a lower bound in the same way: it finds the packages
     that declare a formalization, not the packages that have one. */
  formalizationOnly: false,
  /* Packages with no edges in the current graph view. There are ~180 of them and they
     form a meaningless ring of confetti, so they are hidden by default and the graph
     note says so. */
  hideOrphans: true,
  /* The graph draws one package at a time by default. Measured reason in graph.js: drawn
     all at once, 82% of nodes are leaves and one node owns 47% of the edges. */
  graphMode: "focus",
  graphFocus: null,
  query: "",
  topMetric: "used",
  selected: null,
  // Chart form choices. Not in the URL: they are presentation preferences, not scope,
  // and the hash is meant to describe what a link is *about*.
  compForm: "bar",
  mixForm: "chart",
  topForm: "bar",
};

let NM = 1;
export const setMonthCount = (n) => {
  NM = n;
};

function serialise() {
  const p = new URLSearchParams();
  p.set("v", state.view);
  if (state.asof !== NM - 1) p.set("t", state.asof);
  if (state.minStars) p.set("s", state.minStars);
  if (state.classes.size !== CLASSES.length) p.set("c", [...state.classes].join(","));
  if (state.topMetric !== "used") p.set("r", state.topMetric);
  // `m` predates the rename to Hide Mathlib; kept so existing deep links still resolve.
  if (state.collapseMathlib) p.set("m", "1");
  if (state.palomarOnly) p.set("pl", "1");
  // `fz`, not `f`: `f` is already the graph's focused package.
  if (state.formalizationOnly) p.set("fz", "1");
  if (!state.hideOrphans) p.set("o", "1");   // omitted when hidden, the default
  if (state.graphMode === "all") p.set("g", "all");
  if (state.graphFocus) p.set("f", state.graphFocus);
  if (state.query) p.set("q", state.query);
  if (state.selected) p.set("p", state.selected);
  return "#" + p.toString();
}

function writeHash(push) {
  const h = serialise();
  if (h === location.hash) return;
  if (push) history.pushState(null, "", h);
  else history.replaceState(null, "", h);
}

/* Filter and form changes replace: dozens of history entries for one slider drag would
   make Back useless. */
export const syncHash = () => writeHash(false);

/* View and drawer changes push, so Back means what a reader expects it to mean.
 *
 * The prototype used replaceState for everything, which created no history entries at
 * all — pressing Back to close the drawer left the page entirely. That was its
 * best-known gap; this is the fix, together with the hashchange listener in main.js.
 */
export const pushHash = () => writeHash(true);

/* Read the hash into state. Returns the package id to open, if any. */
export function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.has("t")) state.asof = Math.max(0, Math.min(NM - 1, +p.get("t") || 0));
  if (p.has("s")) state.minStars = +p.get("s") || 0;
  if (p.has("c")) state.classes = new Set(p.get("c").split(",").filter((k) => CLS[k]));
  if (!state.classes.size) state.classes = new Set(CLASSES.map((c) => c.k));
  state.topMetric = p.get("r") === "growth" ? "growth" : "used";
  state.collapseMathlib = p.get("m") === "1";
  state.palomarOnly = p.get("pl") === "1";
  state.formalizationOnly = p.get("fz") === "1";
  state.hideOrphans = p.get("o") !== "1";
  state.graphMode = p.get("g") === "all" ? "all" : "focus";
  state.graphFocus = p.get("f") || null;
  state.query = (p.get("q") || "").toLowerCase();
  const v = p.get("v");
  if (v === "overview" || v === "graph" || v === "table") state.view = v;
  return p.get("p");
}
