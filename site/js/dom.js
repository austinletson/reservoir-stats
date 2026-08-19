/* Shared primitives: the class palette, formatting, SVG helpers, the tooltip.
 *
 * Everything user-visible is inserted with textContent, never innerHTML. Package names,
 * owners and descriptions come from repo metadata and are untrusted input.
 */

/* The four dependency classes, in fixed order with fixed assignment.
 *
 * The ordering is a colorblind-safety property, validated for adjacent-pair and
 * all-pairs separation under deuteranopia, protanopia and tritanopia in both modes.
 * Re-ordering it, adding a fifth class, or substituting a chart library's default
 * categorical scale silently breaks that. See the handoff's 02-DESIGN-SYSTEM.md.
 *
 * `hollow` is read only by the graph (graph.js drawNode/drawLegend). Everywhere else the
 * fourth class is a solid gray fill, because a chart whose marks vary in ink weight is not
 * honest about length.
 */
export const CLASSES = [
  { k: "mathlib",     label: "Requires Mathlib only",               short: "Mathlib only",     cssvar: "--c-mathlib", hollow: false },
  { k: "mathlibplus", label: "Requires Mathlib + others",           short: "Mathlib + others", cssvar: "--c-plus",    hollow: false },
  { k: "other",       label: "Requires other packages, not Mathlib", short: "Other packages",  cssvar: "--c-other",   hollow: false },
  { k: "none",        label: "Requires nothing",                    short: "Nothing",          cssvar: "--c-none",    hollow: true },
];
export const CLS = Object.fromEntries(CLASSES.map((c) => [c.k, c]));

/* Read live, not cached: the theme toggle changes these under us. */
export const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const color = (k) => cssv(CLS[k].cssvar);

/* One formatter, reused. `num` is called a few thousand times per render, and constructing
   an Intl formatter per call is one of the more expensive things on that path. */
const NF = new Intl.NumberFormat("en-US");
export const fmt = (n) =>
  n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "K" : NF.format(Math.round(n));
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
/* `many` is explicit because -s is wrong often enough to matter: "1 match" pluralises to
   "matches", and the scope bar printed "0 matchs" until it didn't. */
export const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many || one + "s"}`;
export const num = (n) => NF.format(n);

const SVGNS = "http://www.w3.org/2000/svg";

export function el(tag, attrs, parent) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

export function svgIn(host, w, h) {
  host.textContent = "";
  // width 100% + height auto keeps the aspect ratio, so a narrow card scales the drawing
  // instead of letterboxing it inside a fixed-height box.
  const s = el("svg", { viewBox: `0 0 ${w} ${h}`, width: "100%", preserveAspectRatio: "xMidYMid meet" });
  s.style.height = "auto";
  host.appendChild(s);
  return s;
}

export function txt(parent, x, y, str, cls, extra) {
  const t = el("text", Object.assign({ x, y, class: cls || "tick" }, extra || {}), parent);
  t.textContent = str;
  return t;
}

/* Plain DOM helpers. */
export function tag(name, cls, text) {
  const n = document.createElement(name);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
export function tdc(text, cls) {
  return tag("td", cls, text);
}

/* Dedupe x tick labels, so a one-month range doesn't print the same month three times. */
export function xTicks(s, labels, X, H) {
  const n = labels.length;
  const idx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0);
  const seen = new Set();
  idx.forEach((i) => {
    if (seen.has(labels[i])) return;
    seen.add(labels[i]);
    txt(s, X(i), H - 8, labels[i], "tick", {
      "text-anchor": n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle",
    });
  });
}

/* ---------- tooltip ----------
   Tooltips enhance, never gate. Every value shown here is also reachable in a table
   view or as a direct label; a value only obtainable by hovering is a bug. */
let tipEl = null;
export function showTip(x, y, title, rows) {
  tipEl = tipEl || document.getElementById("tip");
  tipEl.textContent = "";
  tipEl.appendChild(tag("div", "t", title));
  for (const r of rows) {
    const d = tag("div", "r");
    if (r.color) {
      const k = tag("span", "k");
      k.style.background = r.color;
      d.appendChild(k);
    }
    d.appendChild(tag("span", "v", r.value));
    d.appendChild(tag("span", "n", r.name));
    tipEl.appendChild(d);
  }
  tipEl.style.opacity = 1;
  const r = tipEl.getBoundingClientRect();
  let left = x + 14;
  let top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tipEl.style.left = Math.max(8, left) + "px";
  tipEl.style.top = Math.max(8, top) + "px";
}
export const hideTip = () => {
  tipEl = tipEl || document.getElementById("tip");
  tipEl.style.opacity = 0;
};

/* "leanprover/lean4:v4.32.1" -> "v4.32.1". The release part is what a reader recognises;
   the vendor prefix is noise repeated 800 times. Shared so the table and the drawer cannot
   disagree about what a toolchain is called. */
export const toolchainRelease = (p) => (p.toolchain ? p.toolchain.split(":").pop() : null);

/* aria-live announcements for state changes with no visual anchor. */
export const say = (m) => {
  document.getElementById("live").textContent = m;
};
