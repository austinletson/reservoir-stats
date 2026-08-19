/* All packages — the sortable table.
 *
 * This view is not optional. It is the accessibility fallback for every chart and the
 * narrow-screen fallback for the ranking, which is what lets the rest of the app use
 * hover for enhancement rather than for access.
 *
 * The Declarations column the design called for is absent: the registry publishes no
 * declaration counts. Toolchain is here instead, which is a real liveness signal in an
 * ecosystem where every release is breaking. See docs/DATA.md.
 */

import { CLS, color, cssv, num, tag, toolchainRelease } from "./dom.js";
import { state } from "./state.js";
import { growth, matchesQuery } from "./world.js";

const COLS = [
  ["name", "Package", ""],
  ["owner", "Owner", ""],
  ["k", "Requires", ""],
  ["dependents", "Dependents", "num"],
  ["growth", "+12mo", "num"],
  ["ndeps", "Deps", "num"],
  ["stars", "Stars", "num"],
  ["toolchain", "Toolchain", ""],
  ["lastCommit", "Last commit", ""],
];

const MAX_ROWS = 900;

let sortKey = "dependents";
let sortDir = -1;

export function drawAllTable(host, keep, onOpen, onSort) {
  host.textContent = "";

  const thead = tag("thead");
  const tr = tag("tr");
  COLS.forEach(([k, label, cls]) => {
    const th = tag("th", cls);
    th.style.cursor = "pointer";
    th.tabIndex = 0;
    th.setAttribute("aria-sort", sortKey === k ? (sortDir < 0 ? "descending" : "ascending") : "none");
    th.textContent = label + (sortKey === k ? (sortDir < 0 ? " ↓" : " ↑") : "");
    const go = () => {
      if (sortKey === k) sortDir *= -1;
      else { sortKey = k; sortDir = -1; }
      onSort();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    tr.appendChild(th);
  });
  thead.appendChild(tr);
  host.appendChild(thead);

  let rows = [...keep.values()].map((n) => ({
    id: n.p.id,
    name: n.p.name,
    owner: n.p.owner,
    k: CLS[n.k].short,
    kk: n.k,
    dependents: n.dependents,
    growth: growth(n.p.id),
    ndeps: n.deps.length,
    stars: n.p.stars,
    toolchain: toolchainRelease(n.p) || "—",
    lastCommit: n.p.lastCommit || "unknown",
  }));

  // Search filters the table. The scope bar says so, because the same box only dims
  // elsewhere — a known rough edge, deliberately stated rather than hidden.
  if (state.query) rows = rows.filter((r) => matchesQuery(r));

  rows.sort((a, b) => {
    const x = a[sortKey];
    const y = b[sortKey];
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir;
  });

  if (!rows.length) {
    const tb = tag("tbody");
    const r = tag("tr");
    const td = tag("td", "empty",
      state.query ? `No package matches “${state.query}” in this scope.` : "No packages in this scope.");
    td.colSpan = COLS.length;
    r.appendChild(td);
    tb.appendChild(r);
    host.appendChild(tb);
    return;
  }

  // Hoisted: these were read via getComputedStyle inside the row loop, which at 808 rows
  // was ~890 style lookups per render for five constant values.
  const good = cssv("--good");
  const swatch = Object.fromEntries(Object.keys(CLS).map((k) => [k, color(k)]));

  const tb = tag("tbody");
  rows.slice(0, MAX_ROWS).forEach((r) => {
    const trr = tag("tr");
    trr.tabIndex = 0;
    trr.setAttribute("role", "button");
    const go = () => onOpen(r.id);
    trr.addEventListener("click", go);
    trr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
    COLS.forEach(([k, , cls]) => {
      const td = tag("td", cls);
      if (k === "k") {
        const sw = tag("span");
        sw.style.cssText = "display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:7px";
        sw.style.background = swatch[r.kk];
        td.append(sw, document.createTextNode(r.k));
      } else if (k === "growth") {
        td.textContent = (r.growth > 0 ? "+" : "") + r.growth;
        if (r.growth > 0) td.style.color = good;
      } else {
        td.textContent = typeof r[k] === "number" ? num(r[k]) : r[k];
      }
      trr.appendChild(td);
    });
    tb.appendChild(trr);
  });
  host.appendChild(tb);

  // Never silently truncate: if a cap hides rows, say how many.
  if (rows.length > MAX_ROWS) {
    const foot = tag("tfoot");
    const r = tag("tr");
    const td = tag("td", "empty", `Showing the first ${num(MAX_ROWS)} of ${num(rows.length)} rows — narrow the scope to see the rest.`);
    td.colSpan = COLS.length;
    r.appendChild(td);
    foot.appendChild(r);
    host.appendChild(foot);
  }
}
