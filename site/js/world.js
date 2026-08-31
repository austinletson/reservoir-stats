/* The data layer. Read this before anything else in the app.
 *
 * It exists to enforce one rule, which is the whole reason the numbers on this site can
 * be trusted:
 *
 *     Dependency counts are computed over the WHOLE graph at the selected month.
 *     Filters decide what is DISPLAYED, never what is COUNTED.
 *
 * So the computation is two layers and they must not be collapsed into one:
 *
 *   world(t)   every package alive at month t, its edges among those packages, its class
 *              and its dependent count. Memoised per month.
 *   inScope(n) the star and class filters, applied on top, for display and for counts
 *              OF packages — never for counts of edges INTO a package.
 *
 * The design review found the alternative in an early build: it filtered before
 * computing, so at "min stars 100+" it reported that `aesop` had 0 dependents, because
 * every package depending on aesop had been deleted from the graph first. A viewer doing
 * the sensible thing was told confident falsehoods.
 */

import { CLS } from "./dom.js";
import { state } from "./state.js";

export const HUB_MIN = 8;
/* A hub is defined by INCOMING importance. The predicate lives here beside the threshold
   so callers ask rather than re-spell it. */
export const isHub = (n) => n.dependents >= HUB_MIN;

/* The trailing comparison window, in months. An analysis parameter, not a rendering
   constant, so it is named once here rather than written as `- 12` in six places. */
export const YEAR = 12;
export const prevYear = (t = state.asof) => (t - YEAR >= 0 ? t - YEAR : null);

let DATA = null;
export let MONTHS = [];
export let NM = 0;
export let PKGS = [];
export let BY_ID = new Map();
export let MATHLIB = null;
/* How many packages carry a Palomar entry. Zero means the feature has nothing to show —
   the fetch failed, or no recent registration names an indexed package — and main.js
   hides its filter chip rather than offer a control that can only empty the screen. */
export let PALOMAR_N = 0;
/* How many packages carry a formalization.yaml, for the same reason: 22 of 808 today, and
   a build where the GitHub sweep was skipped has none at all. */
export let FORMALIZATION_N = 0;

export function init(data) {
  DATA = data;
  MONTHS = data.months;
  NM = MONTHS.length;
  PKGS = data.packages;
  BY_ID = new Map(PKGS.map((p) => [p.id, p]));
  // Lowercased once here rather than per comparison; see matchesQuery.
  for (const p of PKGS) { p.nameLc = p.name.toLowerCase(); p.ownerLc = p.owner.toLowerCase(); }
  MATHLIB = data.mathlibId;
  PALOMAR_N = PKGS.reduce((n, p) => n + (hasPalomar(p) ? 1 : 0), 0);
  FORMALIZATION_N = PKGS.reduce((n, p) => n + (hasFormalization(p) ? 1 : 0), 0);
  worldCache.clear();
  seriesKey = null;
  return DATA;
}
export const meta = () => DATA;

/* Palomar entries are attached to a package only when the registry has some, so the
   field is absent far more often than it is empty. See docs/DATA.md. */
export const hasPalomar = (p) => !!(p.palomar && p.palomar.length);

/* Absent unless the repository has the file, so presence is the whole test. Says nothing
   about whether the package formalizes anything — see docs/DATA.md. */
export const hasFormalization = (p) => !!p.formalization;

/* The dependencies a package declared as of month t.
 *
 * `depsHistory` is a sparse list of change points, [[offsetFromFirstMonth, deps], ...],
 * in increasing order. Most packages have exactly one. This is an extension to the
 * handoff's data contract: 41% of packages with more than one indexed version changed
 * their dependency set at least once, and 30 flipped whether they use Mathlib at all,
 * so freezing today's dependencies across history would backdate present-day Mathlib
 * adoption onto 2024. See docs/DATA.md.
 */
export function depsAt(p, t) {
  let cur = [];
  for (const [off, deps] of p.depsHistory) {
    if (p.firstMonth + off > t) break;
    cur = deps;
  }
  return cur;
}

const worldCache = new Map();

/* The whole registry as it stood at one month. Memoised — the time slider recomputes
   this on every drag, and 34 months of 800 packages is the difference between instant
   and janky. */
export function world(t) {
  if (worldCache.has(t)) return worldCache.get(t);

  const live = new Set();
  for (const p of PKGS) if (p.firstMonth <= t) live.add(p.id);

  const w = new Map();
  for (const id of live) {
    const p = BY_ID.get(id);
    // A dependency on a package not yet indexed is dropped: at month t that edge could
    // not have resolved. The builder already enforces this, and doing it again here
    // keeps the invariant local to the code that relies on it.
    const deps = depsAt(p, t).filter((d) => live.has(d));
    let k;
    if (!deps.length) k = "none";
    else if (deps.includes(MATHLIB)) k = deps.length === 1 ? "mathlib" : "mathlibplus";
    else k = "other";
    w.set(id, { p, deps, k, dependents: 0, reachesMathlib: false });
  }
  for (const n of w.values()) for (const d of n.deps) w.get(d).dependents++;

  // Does this package end up pulling Mathlib in at all, through any chain? Memoised
  // within the month; `seen` breaks cycles, which the registry does contain.
  const memo = new Map();
  const reaches = (id, seen) => {
    if (id === MATHLIB) return true;
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return false;
    seen.add(id);
    const n = w.get(id);
    if (!n) return false;
    const r = n.deps.some((d) => reaches(d, seen));
    memo.set(id, r);
    return r;
  };
  for (const [id, n] of w) n.reachesMathlib = n.deps.some((d) => reaches(d, new Set([id])));

  worldCache.set(t, w);
  return w;
}

/* Display scope. Note what is NOT here: the search query, which is a finder rather than
   a filter, and Collapse Mathlib, which applies only to the ranking. */
export const inScope = (n) =>
  n.p.stars >= state.minStars
  && state.classes.has(n.k)
  && (!state.palomarOnly || hasPalomar(n.p))
  && (!state.formalizationOnly || hasFormalization(n.p));

export function scopedAt(t) {
  const keep = new Map();
  for (const [id, n] of world(t)) if (inScope(n)) keep.set(id, n);
  return keep;
}

export function counts(m) {
  const c = { mathlib: 0, mathlibplus: 0, other: 0, none: 0 };
  for (const n of m.values()) c[n.k]++;
  return c;
}
export const total = (c) => c.mathlib + c.mathlibplus + c.other + c.none;

/* Edges out of a scoped set, and how many of it reach Mathlib at all.
 *
 * Both were computed independently in main.js (the KPI tile) and charts.js (the sentence
 * directly beneath the composition chart). They are the same statistic, and the two
 * sitting next to each other on screen while being derived separately is precisely the
 * contradiction the scope bar calls a P0. Counted here, once. */
export function rollup(m) {
  let edges = 0;
  let direct = 0;
  let transitive = 0;
  for (const n of m.values()) {
    edges += n.deps.length;
    if (n.k === "none") continue;
    if (n.deps.includes(MATHLIB)) direct++;
    if (n.deps.includes(MATHLIB) || n.reachesMathlib) transitive++;
  }
  return { edges, direct, transitive };
}

/* Dependents gained in the trailing 12 months, for the growth ranking.
   Counted over the full graph at both dates, like every other dependent count. */
export function growth(id, t = state.asof) {
  const now = world(t).get(id);
  const then = world(Math.max(0, t - YEAR)).get(id);
  return (now ? now.dependents : 0) - (then ? then.dependents : 0);
}

/* Cumulative dependent count per month, for the drawer's adoption curve.
 *
 * The handoff shipped this precomputed in a second lazily-fetched file, on the grounds
 * that 36 client-side snapshots for 900 packages might be too slow. Memoised it is a few
 * milliseconds, and the Overview builds every month's world anyway, so the second
 * artifact does not exist. See docs/DATA.md.
 */
export function adoption(id, upto = state.asof) {
  const out = [];
  for (let t = 0; t <= upto; t++) {
    const n = world(t).get(id);
    out.push(n ? n.dependents : 0);
  }
  return out;
}

export function dependentsOf(id, t = state.asof) {
  const w = world(t);
  const out = [];
  for (const [oid, on] of w) if (on.deps.includes(id)) out.push(oid);
  // Sorted by their own dependent count, so the first 30 shown are the 30 that matter.
  out.sort((a, b) => w.get(b).dependents - w.get(a).dependents || a.localeCompare(b));
  return out;
}

/* Prefers the lowercase forms cached in init(). Called per node per frame from the graph's
   draw loop while a search is active, where lowercasing allocated ~2,700 throwaway strings
   a frame. Falls back for callers that pass a flat display row rather than a package
   record, so carrying the cached fields is an optimisation and never a correctness
   requirement. */
export const matchesQuery = (p, q = state.query) => {
  if (!q) return true;
  const name = p.nameLc || p.name.toLowerCase();
  const owner = p.ownerLc || p.owner.toLowerCase();
  return name.includes(q) || owner.includes(q);
};

/* Per-month composition series, clamped to the selected date.
 *
 * Memoised on the filter tuple rather than on `asof`, because the series is a PREFIX: for a
 * given set of filters, months 0..n never change as the slider moves. Without this, one
 * drag across 34 months rebuilt all 34 entries on every step to display a shorter prefix of
 * the same array, at roughly 53,000 element visits per render. */
let seriesKey = null;
let seriesAll = null;

export function mixSeries() {
  const key = `${state.minStars}|${[...state.classes].sort().join(",")}`
    + `|${state.palomarOnly ? 1 : 0}|${state.formalizationOnly ? 1 : 0}`;
  if (key !== seriesKey) {
    seriesAll = [];
    for (let t = 0; t < NM; t++) {
      const keep = scopedAt(t);
      const c = counts(keep);
      seriesAll.push({ t: MONTHS[t], c, tot: keep.size, edges: rollup(keep).edges });
    }
    seriesKey = key;
  }
  return seriesAll.slice(0, state.asof + 1);
}
