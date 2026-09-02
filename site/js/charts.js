/* The charts.
 *
 * Rules these obey, each of which was got wrong once during design review:
 *
 *  - Never a dual-axis chart. Two measures of different scale get two charts.
 *  - Every chart has a table view. Not a nice-to-have — it is how values stay reachable
 *    without hovering, and it is the fallback when a chart can't fit.
 *  - Colour follows the entity, not its rank. Filtering a series out never repaints the
 *    survivors.
 *  - Ranking bars are one neutral ink. Bar length is the only quantitative encoding and
 *    nothing is allowed to distort it; the class rides a 9px swatch beside the name.
 *  - Gridlines are solid hairlines, never dashed.
 *  - Direct-label selectively — the endpoint, the extreme. A number on every point is
 *    chaos and goes unread.
 */

import {
  CLASSES, CLS, color, cssv, el, fmt, hideTip, num, pct, showTip, svgIn, tag, tdc, txt, xTicks,
} from "./dom.js";
import { state } from "./state.js";
import { counts, MONTHS, prevYear, scopedAt } from "./world.js";

/* The scoped composition a year before the selected month, or null when there is not a
   year of history yet. Both the ghost bar and the drift sentence need exactly this. */
function yearEarlier() {
  const t = prevYear();
  if (t === null) return null;
  const keep = scopedAt(t);
  return keep.size ? { t, c: counts(keep), tot: keep.size } : null;
}

/* ================= composition: what packages require ================= */

export function drawComposition(host, c, total) {
  if (state.compForm === "table") {
    host.textContent = "";
    const tb = tag("table", "tv");
    const thead = tag("thead");
    const htr = tag("tr");
    ["Dependency class", "Packages", "Share"].forEach((h, i) => {
      const th = tag("th", i ? "num" : "", h);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    tb.appendChild(thead);
    const body = tag("tbody");
    for (const cl of CLASSES) {
      const tr = tag("tr");
      tr.append(tdc(cl.label), tdc(num(c[cl.k]), "num"), tdc(pct(c[cl.k], total) + "%", "num"));
      body.appendChild(tr);
    }
    tb.appendChild(body);
    host.appendChild(tb);
    return;
  }

  if (state.compForm === "donut") {
    const S = Math.max(220, Math.min(320, host.clientWidth || 250));
    const R = S * 0.4;
    const r = S * 0.24;
    const cx = S / 2;
    const cy = S / 2;
    const s = svgIn(host, S, S);
    let a0 = -Math.PI / 2;
    const GAP = 0.022;
    CLASSES.forEach((cl) => {
      const v = c[cl.k];
      if (!v) return;
      const span = (v / total) * Math.PI * 2;
      const a1 = a0 + span;
      const pa = a0 + GAP / 2;
      const pb = a1 - GAP / 2;
      if (pb > pa) {
        const large = pb - pa > Math.PI ? 1 : 0;
        const d = [
          "M", cx + R * Math.cos(pa), cy + R * Math.sin(pa),
          "A", R, R, 0, large, 1, cx + R * Math.cos(pb), cy + R * Math.sin(pb),
          "L", cx + r * Math.cos(pb), cy + r * Math.sin(pb),
          "A", r, r, 0, large, 0, cx + r * Math.cos(pa), cy + r * Math.sin(pa), "Z",
        ].join(" ");
        const path = el("path", { d, fill: color(cl.k) }, s);
        path.addEventListener("pointermove", (e) =>
          showTip(e.clientX, e.clientY, cl.label, [
            { value: num(v) + " pkgs", name: pct(v, total) + "% of packages in scope", color: color(cl.k) },
          ]));
        path.addEventListener("pointerleave", hideTip);
        const mid = (pa + pb) / 2;
        if (v / total > 0.06) {
          const lx = cx + (R + 16) * Math.cos(mid);
          const ly = cy + (R + 16) * Math.sin(mid);
          txt(s, lx, ly + 4, pct(v, total) + "%", "dlab", {
            "text-anchor": Math.cos(mid) < -0.2 ? "end" : Math.cos(mid) > 0.2 ? "start" : "middle",
          });
        }
      }
      a0 = a1;
    });
    txt(s, cx, cy - 2, fmt(total), "dlab", { "text-anchor": "middle", "font-size": "26", "font-weight": "640" });
    txt(s, cx, cy + 16, "packages", "tick", { "text-anchor": "middle" });
    return;
  }

  /* Default: 100% stacked horizontal bar. Better than a donut for near-tied values,
     which these are. Below it, the same composition 12 months earlier as a thinner bar
     in the same order and hues, so change is visible without a second chart. */
  const W = Math.max(300, Math.min(760, host.clientWidth || 640));
  const H = 128;
  const GAP = 2;
  const s = svgIn(host, W, H);

  function stack(y, BAR, cc, tot, withLabels) {
    let x = 0;
    const segs = CLASSES
      .map((cl) => ({ cl, v: cc[cl.k], w: tot ? (cc[cl.k] / tot) * W : 0 }))
      .filter((o) => o.v > 0);
    segs.forEach((o, i) => {
      const last = i === segs.length - 1;
      // The 2px gap is drawn by leaving surface showing, never as a stroke around the mark.
      const w = Math.max(0, o.w - (last ? 0 : GAP));
      const rx = Math.min(4, w / 2);
      const g = el("g", {}, s);
      el("rect", { x, y, width: w, height: BAR, rx, fill: color(o.cl.k) }, g);
      if (withLabels) {
        const label = pct(o.v, tot) + "%";
        // A label that doesn't fit inside its mark moves outside it; it is never clipped.
        if (w > 46) txt(g, x + w / 2, y + BAR / 2 + 4, label, "dlab inv", { "text-anchor": "middle" });
        else if (w > 6) txt(g, x + w / 2, y - 7, label, "dlab", { "text-anchor": "middle" });
      }
      // Hit target is larger than the mark — at least ~24px including the gap.
      const hit = el("rect", { x, y: y - 10, width: Math.max(w, 6), height: BAR + 20, fill: "transparent" }, g);
      hit.addEventListener("pointermove", (e) =>
        showTip(e.clientX, e.clientY, o.cl.label, [
          { value: num(o.v) + " pkgs", name: pct(o.v, tot) + "% of packages in scope", color: color(o.cl.k) },
        ]));
      hit.addEventListener("pointerleave", hideTip);
      x += o.w;
    });
  }

  txt(s, 0, 12, MONTHS[state.asof], "tick");
  stack(22, 40, c, total, true);
  const then = yearEarlier();
  if (then) {
    txt(s, 0, 92, "A year earlier · " + MONTHS[then.t], "tick");
    stack(102, 14, then.c, then.tot, false);
  }
}

/* The interpretive sentences live outside the chart, so every form keeps them.
   A dashboard that makes the reader do all the interpreting is one nobody reads twice. */
export function drawCompSummary(host, c, total, roll) {
  host.textContent = "";
  const mlAll = c.mathlib + c.mathlibplus;
  // `roll` comes from world.rollup(), so this sentence and the KPI tile above it are the
  // same number by construction rather than by two loops agreeing.
  const trans = roll.transitive;
  const line = (strongTxt, restTxt) => {
    const d = tag("div");
    d.append(tag("b", "", strongTxt), document.createTextNode(" " + restTxt));
    host.appendChild(d);
  };
  line(pct(mlAll, total) + "%", `of packages require Mathlib directly; ${pct(trans, total)}% end up pulling it in.`);
  line(pct(c.none, total) + "%", "require nothing at all.");

  const d = tag("div");
  d.style.color = "var(--muted)";
  d.style.fontSize = "12.5px";
  const then = yearEarlier();
  if (then) {
    const drift = pct(mlAll, total) - pct(then.c.mathlib + then.c.mathlibplus, then.tot);
    const move = drift === 0
      ? "held flat"
      : `${drift > 0 ? "grown" : "fallen"} ${Math.abs(drift)} pt${Math.abs(drift) === 1 ? "" : "s"}`;
    d.textContent = `Mathlib's direct share has ${move} over the last 12 months.`;
  } else {
    d.textContent = "No year-on-year comparison — less than 12 months of history at this date.";
  }
  host.appendChild(d);
}

/* One legend. `counts` is optional: the composition card shows a per-class total beside
   each label, the mix chart does not, and that was the only difference between what used
   to be two near-identical functions. */
export function drawLegend(host, counts) {
  host.textContent = "";
  for (const cl of CLASSES) {
    const d = tag("span", "it");
    const sw = tag("span", "sw");
    sw.style.background = color(cl.k);
    if (counts) d.append(sw, tag("span", "n", num(counts[cl.k])), document.createTextNode(cl.label));
    else d.append(sw, document.createTextNode(cl.label));
    host.appendChild(d);
  }
}

/* ================= mix over time: 100% stacked area ================= */

export function drawMix(host, series) {
  if (state.mixForm === "table") {
    host.textContent = "";
    const wrap = tag("div");
    wrap.style.cssText = "max-height:250px;overflow:auto";
    const tb = tag("table", "tv");
    const thead = tag("thead");
    const htr = tag("tr");
    ["Month", ...CLASSES.map((c) => c.short), "Total"].forEach((h, i) => {
      htr.appendChild(tag("th", i ? "num" : "", h));
    });
    thead.appendChild(htr);
    tb.appendChild(thead);
    const body = tag("tbody");
    series.slice().reverse().forEach((r) => {
      const tr = tag("tr");
      tr.append(tdc(r.t), ...CLASSES.map((cl) => tdc(pct(r.c[cl.k], r.tot) + "%", "num")), tdc(num(r.tot), "num"));
      body.appendChild(tr);
    });
    tb.appendChild(body);
    wrap.appendChild(tb);
    host.appendChild(wrap);
    return;
  }

  const W = Math.max(300, Math.min(620, host.clientWidth || 480));
  const H = 250;
  const ML = 34, MR = 10, MT = 8, MB = 26;
  const pw = W - ML - MR;
  const ph = H - MT - MB;
  const n = series.length;
  const s = svgIn(host, W, H);
  const surf = cssv("--surface");
  const X = (i) => ML + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);

  [0, 25, 50, 75, 100].forEach((v) => {
    const y = MT + ph - (v / 100) * ph;
    el("line", { x1: ML, x2: ML + pw, y1: y, y2: y, class: "gl" }, s);
    txt(s, ML - 7, y + 4, v + "%", "tick", { "text-anchor": "end" });
  });

  const orderK = CLASSES.map((c) => c.k);
  let prev = new Array(n).fill(0);
  const cum = new Array(n).fill(0);
  orderK.forEach((k) => {
    const top = [];
    for (let i = 0; i < n; i++) {
      cum[i] += series[i].tot ? (series[i].c[k] / series[i].tot) * 100 : 0;
      top.push(cum[i]);
    }
    const up = top.map((v, i) => `${X(i)},${MT + ph - (v / 100) * ph}`).join(" L ");
    const dn = prev.map((v, i) => `${X(i)},${MT + ph - (v / 100) * ph}`).reverse().join(" L ");
    if (n > 1) {
      el("path", { d: `M ${up} L ${dn} Z`, fill: color(k), "fill-opacity": 0.9 }, s);
      // The separation between bands is surface showing through, not a stroke.
      el("path", { d: `M ${up}`, fill: "none", stroke: surf, "stroke-width": 2 }, s);
    }
    prev = top;
  });

  if (n <= 1) txt(s, ML + pw / 2, MT + ph / 2, "Not enough history at this date", "tick", { "text-anchor": "middle" });
  el("line", { x1: ML, x2: ML + pw, y1: MT + ph, y2: MT + ph, class: "ax" }, s);
  xTicks(s, series.map((r) => r.t), X, H);

  // A crosshair snapping to the nearest month: the reader aims at a date, never at a 2px line.
  const cross = el("line", { x1: 0, x2: 0, y1: MT, y2: MT + ph, class: "ax", opacity: 0 }, s);
  const hit = el("rect", { x: ML, y: MT, width: pw, height: ph, fill: "transparent" }, s);
  hit.addEventListener("pointermove", (e) => {
    const r = s.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round((((e.clientX - r.left) / r.width) * W - ML) / pw * (n - 1))));
    cross.setAttribute("x1", X(i));
    cross.setAttribute("x2", X(i));
    cross.setAttribute("opacity", 1);
    const row = series[i];
    showTip(e.clientX, e.clientY, `${row.t} · ${num(row.tot)} packages`,
      CLASSES.map((cl) => ({ value: pct(row.c[cl.k], row.tot) + "%", name: cl.label, color: color(cl.k) })));
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("opacity", 0);
    hideTip();
  });
}

/* ================= ranked bars ================= */

export function drawTop(calloutHost, host, rows, metric, onOpen) {
  calloutHost.textContent = "";

  /* Pull a runaway leader into a callout so ranks 2..N get the full scale.
     Mathlib has ~7x the dependents of the next package; on a shared axis it flattens
     every other bar to a stub, which loses the very information the chart is for. */
  let lead = null;
  if (rows.length > 1 && rows[0].v >= rows[1].v * 2.5) {
    lead = rows[0];
    rows = rows.slice(1);
  }
  if (lead) {
    const c = tag("button", "callout");
    c.type = "button";
    c.style.width = "100%";
    const why = metric === "used"
      ? `dependents · ${lead.share}% of every package in the graph`
      : "new dependents in 12 months";
    c.append(
      tag("span", "nm", lead.name),
      tag("span", "big", num(lead.v)),
      tag("span", "why", why + " · shown separately for readability"),
    );
    c.addEventListener("click", () => onOpen(lead.id));
    calloutHost.appendChild(c);
  }

  /* A 13-row ranking with long package names is illegible below ~640px. The table is the
     same data and stays readable, so switch rather than shrink. */
  const narrow = host.clientWidth && host.clientWidth < 640;
  if (state.topForm === "table" || narrow) {
    host.textContent = "";
    if (narrow && state.topForm !== "table") {
      host.appendChild(tag("p", "cap", "Table shown on narrow screens."));
    }
    const tb = tag("table", "tv");
    const thead = tag("thead");
    const htr = tag("tr");
    const heads = metric === "used"
      ? ["Package", "Owner", "Dependents", "Stars"]
      : ["Package", "Owner", "New dependents (12mo)", "Total dependents", "Stars"];
    heads.forEach((h, i) => htr.appendChild(tag("th", i > 1 ? "num" : "", h)));
    thead.appendChild(htr);
    tb.appendChild(thead);
    const b = tag("tbody");
    (lead ? [lead, ...rows] : rows).forEach((r) => {
      const tr = tag("tr");
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      const go = () => onOpen(r.id);
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      });
      tr.append(tdc(r.name), tdc(r.owner), tdc(num(r.v), "num"));
      if (metric !== "used") tr.appendChild(tdc(num(r.total), "num"));
      tr.appendChild(tdc(num(r.stars), "num"));
      b.appendChild(tr);
    });
    tb.appendChild(b);
    host.appendChild(tb);
    return;
  }

  if (!rows.length) {
    host.textContent = "";
    host.appendChild(tag("p", "empty", "Nothing to rank in this scope."));
    return;
  }

  const W = Math.max(660, Math.min(1240, host.clientWidth || 1100));
  const ROW = 30;
  const PAD_L = Math.round(W * 0.22) + 30;
  const PAD_R = 90;
  const MT = 6;
  const H = MT + rows.length * ROW + 26;
  const s = svgIn(host, W, H);

  const raw = Math.max(1, ...rows.map((r) => r.v));
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => raw / v <= 5) || 10 * mag;
  const max = Math.ceil(raw / step) * step;
  const pw = W - PAD_L - PAD_R;

  for (let v = 0; v <= max + 1e-9; v += step) {
    const x = PAD_L + (v / max) * pw;
    el("line", { x1: x, x2: x, y1: MT, y2: MT + rows.length * ROW, class: "gl" }, s);
    txt(s, x, H - 8, num(Math.round(v)), "tick", { "text-anchor": "middle" });
  }

  rows.forEach((r, i) => {
    const y = MT + i * ROW;
    const bh = 18;
    const by = y + (ROW - bh) / 2;
    const w = Math.max(2, (r.v / max) * pw);
    txt(s, PAD_L - 38, by + 13, r.name, "rowlab", { "text-anchor": "end" });
    const rr = Math.min(4, w / 2);
    // The class rides a swatch beside the name, where it can't distort the magnitude.
    el("rect", { x: PAD_L - 30, y: by + 5, width: 9, height: 9, rx: 2, fill: color(r.k) }, s);
    // Rounded at the data end, square at the baseline.
    el("path", {
      d: `M ${PAD_L} ${by} H ${PAD_L + w - rr} a ${rr} ${rr} 0 0 1 ${rr} ${rr} V ${by + bh - rr} `
        + `a ${rr} ${rr} 0 0 1 ${-rr} ${rr} H ${PAD_L} Z`,
      fill: cssv("--neutral"),
    }, s);
    txt(s, PAD_L + w + 9, by + 13, num(r.v), "dlab");

    const hit = el("rect", { x: 0, y, width: W, height: ROW, fill: "transparent" }, s);
    hit.style.cursor = "pointer";
    hit.addEventListener("pointermove", (e) =>
      showTip(e.clientX, e.clientY, r.id, [
        { value: num(r.total), name: "total dependents", color: color(r.k) },
        { value: (r.growth >= 0 ? "+" : "") + r.growth, name: "new dependents, 12 months" },
        { value: CLS[r.k].label, name: "class" },
      ]));
    hit.addEventListener("pointerleave", hideTip);
    hit.addEventListener("click", () => onOpen(r.id));
  });
}

/* ================= line chart: one measure, one series ================= */

export function lineChart(host, opts) {
  const { values, months, H = 210, colorKey = "--neutral", unit = "" } = opts;
  const W = opts.W || Math.max(300, Math.min(640, host.clientWidth || 470));
  const ML = 44, MR = 14, MT = 10, MB = 26;
  const pw = W - ML - MR;
  const ph = H - MT - MB;
  const s = svgIn(host, W, H);
  const n = values.length;
  const max = Math.max(1, ...values);
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / (nice / 2)) * (nice / 2);
  const X = (i) => ML + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
  const Y = (v) => MT + ph - (v / top) * ph;

  /* Dedupe by rendered label, not by value. These counts are whole numbers, so a chart
     topping out at 1 — a package with no dependents yet — would otherwise draw ticks at
     0, 0.5 and 1 and label them "0", "1", "1". Two gridlines labelled the same thing
     read as a rendering fault and undermine the axis. */
  const seen = new Set();
  [top, top / 2, 0].forEach((v) => {
    const label = fmt(v);
    if (seen.has(label)) return;
    seen.add(label);
    el("line", { x1: ML, x2: ML + pw, y1: Y(v), y2: Y(v), class: "gl" }, s);
    txt(s, ML - 8, Y(v) + 4, label, "tick", { "text-anchor": "end" });
  });

  const hue = cssv(colorKey);
  if (n > 1) {
    const d = values.map((v, i) => `${i ? "L" : "M"} ${X(i)} ${Y(v)}`).join(" ");
    el("path", { d: `${d} L ${X(n - 1)} ${MT + ph} L ${X(0)} ${MT + ph} Z`, fill: hue, "fill-opacity": 0.1 }, s);
    el("path", { d, fill: "none", stroke: hue, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, s);
  }
  // Only the endpoint is labelled. A single series needs no legend; the title says what's plotted.
  el("circle", { cx: X(n - 1), cy: Y(values[n - 1]), r: 4.5, fill: hue, stroke: cssv("--surface"), "stroke-width": 2 }, s);
  txt(s, X(n - 1) - 6, Y(values[n - 1]) - 11, fmt(values[n - 1]) + unit, "dlab", { "text-anchor": "end" });
  el("line", { x1: ML, x2: ML + pw, y1: MT + ph, y2: MT + ph, class: "ax" }, s);
  xTicks(s, months, X, H);

  const cross = el("line", { x1: 0, x2: 0, y1: MT, y2: MT + ph, class: "ax", opacity: 0 }, s);
  const dot = el("circle", { r: 4.5, fill: hue, stroke: cssv("--surface"), "stroke-width": 2, opacity: 0 }, s);
  const hit = el("rect", { x: ML, y: MT, width: pw, height: ph, fill: "transparent" }, s);
  hit.addEventListener("pointermove", (e) => {
    const r = s.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round((((e.clientX - r.left) / r.width) * W - ML) / pw * (n - 1))));
    cross.setAttribute("x1", X(i));
    cross.setAttribute("x2", X(i));
    cross.setAttribute("opacity", 1);
    dot.setAttribute("cx", X(i));
    dot.setAttribute("cy", Y(values[i]));
    dot.setAttribute("opacity", 1);
    showTip(e.clientX, e.clientY, months[i], [{ value: num(Math.round(values[i])) + unit, name: opts.name, color: hue }]);
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("opacity", 0);
    dot.setAttribute("opacity", 0);
    hideTip();
  });
}
