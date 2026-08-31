/* The package drawer. Opens from any view — table row, ranking bar, callout, search
 * autocomplete, or a dependency pill in another package's drawer.
 *
 * A developer's next action after reading this panel is always "go look at the repo", so
 * the repository and Reservoir links are at the top. An early design had no links at all.
 */

import { CLS, color, cssv, num, plural, tag } from "./dom.js";
import { lineChart } from "./charts.js";
import { state } from "./state.js";
import { adoption, BY_ID, dependentsOf, MONTHS, world } from "./world.js";

const MAX_PILLS = 30;
/* Palomar publishes no human-facing page per entry, so the record itself is the link.
   `path` is relative to the feed's host and comes from the feed. */
const PALOMAR_HOST = "https://data.palomar-registry.org/";

let onNavigate = null;   // set by main.js: (id) => void, so pills re-enter through it
let onClose = null;

export function initDrawer(handlers) {
  onNavigate = handlers.navigate;
  onClose = handlers.close;
  document.getElementById("closeDrawer").addEventListener("click", () => onClose());
  document.getElementById("scrim").addEventListener("click", () => onClose());
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) onClose();
  });
}

export const isOpen = () => document.getElementById("drawer").classList.contains("open");

let lastFocus = null;

export function renderDrawer(id) {
  const p = BY_ID.get(id);
  if (!p) return false;

  const T = state.asof;
  const w = world(T);
  const n = w.get(id);
  const cls = CLS[n ? n.k : "none"];
  const body = document.getElementById("drawerBody");
  body.textContent = "";

  const h2 = tag("h2", "", p.name);
  h2.id = "drawerTitle";
  body.append(h2, tag("div", "owner", "@" + p.owner));

  if (p.description) {
    const d = tag("p", "", p.description);
    d.style.cssText = "margin:8px 0 0;font-size:12.5px;color:var(--ink2)";
    body.appendChild(d);
  }

  const links = tag("div");
  links.style.cssText = "margin-top:10px;display:flex;gap:14px;font-size:12.5px;flex-wrap:wrap";
  const a1 = tag("a", "", "Repository ↗");
  a1.href = p.repoUrl || "https://github.com/" + p.id;
  a1.target = "_blank";
  a1.rel = "noopener noreferrer";
  const a2 = tag("a", "", "Reservoir ↗");
  a2.href = `https://reservoir.lean-lang.org/@${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}`;
  a2.target = "_blank";
  a2.rel = "noopener noreferrer";
  links.append(a1, a2);
  body.appendChild(links);

  /* Badges. The build badge names the toolchain rather than claiming "builds on latest":
     Reservoir builds each package against the toolchain that package pins, so a bare
     boolean would be saying something the data doesn't support. See docs/DATA.md. */
  const meta = tag("div");
  meta.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:12px";
  const b1 = tag("span", "badge");
  const sw = tag("span", "sw");
  sw.style.background = color(cls.k);
  b1.append(sw, document.createTextNode(cls.label));
  meta.appendChild(b1);

  const release = p.toolchain ? p.toolchain.split(":").pop() : null;
  const b2 = tag("span", "badge");
  b2.textContent = release
    ? (p.builds ? `Builds on ${release}` : `Fails on ${release}`)
    : (p.builds ? "Builds" : "Build failing");
  b2.style.color = p.builds ? cssv("--good") : cssv("--crit");
  meta.appendChild(b2);

  if (p.toolchainCurrent) {
    meta.appendChild(tag("span", "badge", "On the newest toolchain"));
  } else if (release) {
    const b3 = tag("span", "badge", "Behind the newest toolchain");
    b3.style.color = cssv("--muted");
    meta.appendChild(b3);
  }
  if (p.stale) {
    const b4 = tag("span", "badge", "No commits in 12 months");
    b4.style.color = cssv("--crit");
    meta.appendChild(b4);
  }
  const palomar = p.palomar || [];
  if (palomar.length) {
    const b5 = tag("span", "badge", plural(palomar.length, "Palomar entry", "Palomar entries"));
    b5.style.color = cssv("--good");
    meta.appendChild(b5);
  }
  /* `sorry_count: 0` is the one thing in formalization.yaml that a reader scanning the
     panel wants first, so it is a badge and not a row in the section below. Silence is
     not zero: a file that declares no count gets the plain badge, never "no sorry". */
  const f = p.formalization;
  if (f) {
    const b6 = tag("span", "badge", f.sorryCount === 0 ? "formalization.yaml, no sorry" : "formalization.yaml");
    b6.style.color = cssv(f.sorryCount === 0 ? "--good" : "--ink2");
    meta.appendChild(b6);
  }
  body.appendChild(meta);

  const dl = tag("dl", "facts");
  const fact = (k, v) => {
    dl.append(tag("dt", "", k), tag("dd", "", v));
  };
  fact("Latest version", p.version || "no tagged release");
  fact("Last commit", p.lastCommit || "unknown");
  fact("Stars", num(p.stars));
  // Absent is not zero: a package with no license says "not declared", and a package
  // with genuinely zero dependents says 0. They mean different things.
  fact("License", p.license || "not declared");
  fact("First indexed", MONTHS[p.firstMonth]);
  fact("Toolchain", release || "unknown");
  body.appendChild(dl);

  const section = (title, cap, h4cls) => {
    const s = tag("div", "dsec");
    const h4 = tag("h4", h4cls || "", title);
    const c = tag("p", "cap", cap);
    c.style.cssText = "color:var(--muted);margin:0 0 6px";
    const host = tag("div");
    s.append(h4, c, host);
    body.appendChild(s);
    return host;
  };

  /* Palomar, above the charts because it is a claim about what this repository *proves*,
     which is the strongest thing on the panel and would be buried under 30 dependent
     pills. The caption states the feed's limit: it carries recent registrations only, so
     the count is a lower bound and a package showing nothing here may still be listed. */
  if (palomar.length) {
    const palHost = section(
      "On Palomar",
      "Lean-verified results registered against this repository, newest first. Palomar's "
      + "feed carries recent registrations only, so this may not be all of them.",
    );
    palomar.forEach((e) => palHost.appendChild(palomarEntry(e)));
  }

  /* formalization.yaml, next to Palomar because they answer the same question from
     opposite ends: Palomar is a third party's record of a verified result, this is the
     project's own declaration of what it set out to prove and how far it got.
     Self-reported, which the caption has to say out loud. */
  if (f) {
    formalizationSection(section, f, p);
  }

  /* Adoption. The "+N in the last 12 months" in the caption is the point: a cumulative
     curve on its own makes an abandoned package look like a healthy plateau. */
  const adopt = adoption(id, T);
  const gained = adopt[T] - (T >= 12 ? adopt[T - 12] : 0);
  if (T > 0) {
    lineChart(
      section("Adoption", `Packages depending on it, cumulative. ${gained >= 0 ? "+" : ""}${gained} in the last 12 months.`),
      { values: adopt, months: MONTHS.slice(0, T + 1), W: 400, H: 180, name: "dependents", colorKey: "--neutral" },
    );
  }
  /* No code-size chart: the registry publishes no declaration counts, and interpolating
     one would be a fabricated growth curve. Stated in the footer, not hidden. */

  const deps = n ? n.deps : [];
  const depHost = section("Requires", plural(deps.length, "package"));
  if (deps.length) deps.forEach((d) => depHost.appendChild(pillFor(d)));
  else depHost.appendChild(muted("Nothing — this package is standalone."));

  const dependents = dependentsOf(id, T);
  const dtHost = section("Depended on by",
    plural(dependents.length, "package") + (dependents.length > MAX_PILLS ? ` — ${MAX_PILLS} most-depended-on shown` : ""));
  if (dependents.length) {
    dependents.slice(0, MAX_PILLS).forEach((d) => dtHost.appendChild(pillFor(d)));
    if (dependents.length > MAX_PILLS) dtHost.appendChild(muted(`+${dependents.length - MAX_PILLS} more`));
  } else {
    dtHost.appendChild(muted("Nothing depends on it yet."));
  }

  return true;
}

/* One registered result. The theorem names are the substance — `title` is the repository
   again in every entry seen so far — so they lead, and the rest is one muted line. */
function palomarEntry(e) {
  const box = tag("div", "palo");
  const head = tag("div", "palo-head");
  const names = (e.theorems && e.theorems.length) ? e.theorems : [e.title || e.id];
  names.forEach((t) => head.appendChild(tag("code", "", t)));
  box.appendChild(head);

  const line = tag("div", "palo-meta");
  const bits = [
    e.publishedAt ? e.publishedAt.slice(0, 10) : null,
    e.status,
    e.trust ? e.trust + " trust" : null,
  ].filter(Boolean);
  line.appendChild(tag("span", "", bits.join(" · ")));
  if (e.path) {
    const a = tag("a", "", "Record ↗");
    a.href = PALOMAR_HOST + e.path;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    line.appendChild(a);
  }
  box.appendChild(line);
  return box;
}

/* One formalization.yaml, as a claim (scope), a completeness line (sorry, axioms), the
   declarations it names, and what it formalizes (sources). Every part is optional: the
   schema requires four keys and the files in the wild fill in wildly different subsets,
   so anything absent is simply not drawn rather than drawn as "unknown". */
function formalizationSection(section, f, p) {
  const host = section(
    "formalization.yaml",
    "Declared by the project in its own repository"
    + (f.version ? `, to schema ${f.version}` : "") + ". Read as a claim, not a check.",
    "file",
  );

  /* A link to the file itself, because every claim below is checkable only against it.
     Labelled "View the file" rather than repeating the name a third time in four lines,
     the heading and the caption having said it already. `HEAD` rather than a branch name:
     the summary carries no default branch, and GitHub resolves HEAD to whatever it is. */
  const src = tag("div");
  src.style.cssText = "margin:0 0 8px;font-size:12.5px";
  const a = tag("a", "", "View the file ↗");
  a.href = (p.repoUrl || "https://github.com/" + p.id).replace(/\/$/, "")
    + "/blob/HEAD/formalization.yaml";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  src.appendChild(a);
  host.appendChild(src);

  if (f.description && f.description !== p.description) {
    const d = tag("p", "", f.description);
    d.style.cssText = "margin:0 0 8px;font-size:12.5px;color:var(--ink2)";
    host.appendChild(d);
  }

  const dl = tag("dl", "facts");
  const fact = (k, v) => dl.append(tag("dt", "", k), tag("dd", "", v));
  // Absent and zero say different things, so only a declared count is shown as a number.
  if (typeof f.sorryCount === "number") {
    fact("Sorry", f.sorryCount === 0
      ? "none declared"
      : plural(f.sorryCount, "sorry", "sorries")
        + (f.sorryInDefinitions ? `, ${f.sorryInDefinitions} in definitions` : ""));
  }
  if (f.axioms && f.axioms.length) fact("Axioms", f.axioms.join(", "));
  if (f.role) fact("Repository role", f.role.replace(/-/g, " "));
  if (f.automation && f.automation.length) fact("Produced by", f.automation.join(", "));
  if (f.review) fact("Review", f.review);
  if (f.license) fact("Declared license", f.license);
  if (f.authors && f.authors.length) {
    fact("Authors", f.authors.length > 6
      ? `${f.authors.slice(0, 6).join(", ")} +${f.authors.length - 6} more`
      : f.authors.join(", "));
  }
  const subjects = [...(f.arxiv || []), ...(f.msc2020 || [])];
  if (subjects.length) fact("Classified", subjects.join(", "));
  if (dl.childElementCount) host.appendChild(dl);

  if (f.scope) {
    const sc = tag("p", "", f.scope);
    sc.style.cssText = "margin:8px 0 0;font-size:12.5px;color:var(--ink2)";
    host.append(tag("h5", "", "Scope"), sc);
  }

  /* The declarations are the substance: a named theorem in a named file is the one part
     of this file a reader can go and check for themselves. */
  if (f.mainResults && f.mainResults.length) {
    host.appendChild(tag("h5", "", plural(f.mainResults.length, "Main result")));
    f.mainResults.forEach((r) => {
      const box = tag("div", "palo");
      const head = tag("div", "palo-head");
      if (r.declaration) head.appendChild(tag("code", "", r.declaration));
      box.appendChild(head);
      const bits = [r.file, typeof r.sorryCount === "number" && r.sorryCount > 0
        ? plural(r.sorryCount, "sorry", "sorries") : null].filter(Boolean);
      if (bits.length) {
        const line = tag("div", "palo-meta");
        line.appendChild(tag("span", "", bits.join(" · ")));
        box.appendChild(line);
      }
      host.appendChild(box);
    });
  }

  if (f.sources && f.sources.length) {
    host.appendChild(tag("h5", "", plural(f.sources.length, "Source")));
    f.sources.forEach((src) => {
      const box = tag("div", "palo");
      box.appendChild(tag("div", "palo-head", src.title || src.id || "untitled"));
      const line = tag("div", "palo-meta");
      line.appendChild(tag("span", "", [src.type, src.relationship].filter(Boolean).join(" · ")));
      // Only arXiv and DOI ids are dereferenceable; an ISBN or a bare string is not.
      const href = sourceHref(src.id);
      if (href) {
        const a = tag("a", "", "Source ↗");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        line.appendChild(a);
      } else if (src.id) {
        line.appendChild(tag("span", "", src.id));
      }
      box.appendChild(line);
      host.appendChild(box);
    });
  }
}

/* `sources[].id` is a free-text identifier in the schema. In the files seen so far it is
   an arXiv URL, a DOI, or an ISBN, and only the first two resolve to anything. */
function sourceHref(id) {
  if (!id) return null;
  if (/^https?:\/\//.test(id)) return id;
  if (/^10\.\d{4,}\//.test(id)) return "https://doi.org/" + id;
  if (/^arxiv:/i.test(id)) return "https://arxiv.org/abs/" + id.slice(6).trim();
  return null;
}

function muted(text) {
  const s = tag("span", "", text);
  s.style.color = "var(--muted)";
  return s;
}

function pillFor(id) {
  const p = BY_ID.get(id);
  const b = tag("button", "pill", p ? `${p.name} @${p.owner}` : id);
  b.type = "button";
  b.addEventListener("click", () => onNavigate(id));
  return b;
}

/* Docked or overlay, decided by viewport width.
 *
 * Docked (>=1000px) the panel is NOT modal: no scrim, no `inert`, no `aria-modal`, and
 * focus is deliberately not contained. That is the point of docking. The page beside it
 * stays live so you can read a package and click its neighbours in the graph at the same
 * time. Below the breakpoint there is no room to push, so it overlays and becomes a real
 * modal again, with the scrim and `inert` that requires.
 *
 * `inert` is what gives containment and background-hiding in one, which is the only thing
 * that makes `aria-modal="true"` honest. So the two are set and cleared together, never
 * one without the other.
 */
const DOCKED = matchMedia("(min-width: 1000px)");

/* Called after the panel opens, closes, or crosses the breakpoint: the page's usable width
   changed, and canvas charts size from their container. */
let onLayoutChange = () => {};
export const setLayoutChangeHandler = (fn) => { onLayoutChange = fn; };

function applyMode() {
  const open = isOpen();
  const drawer = document.getElementById("drawer");
  const docked = DOCKED.matches;
  document.body.classList.toggle("drawer-docked", open && docked);
  document.getElementById("scrim").classList.toggle("on", open && !docked);
  document.querySelector(".wrap").inert = open && !docked;
  if (open && !docked) drawer.setAttribute("aria-modal", "true");
  else drawer.removeAttribute("aria-modal");
}

DOCKED.addEventListener("change", () => {
  applyMode();
  onLayoutChange();
});

export function showDrawer() {
  const drawer = document.getElementById("drawer");
  const wasClosed = !isOpen();
  if (wasClosed) lastFocus = document.activeElement;
  drawer.classList.add("open");
  applyMode();

  const h2 = document.getElementById("drawerTitle");
  // Only on the first open. Moving focus on every subsequent package would yank it off the
  // graph canvas mid-navigation, which is exactly what docking is meant to avoid.
  if (h2 && wasClosed) {
    h2.tabIndex = -1;
    setTimeout(() => h2.focus(), 200);   // after the transition, or it is not yet focusable
  }
  // Once for the width change now, once after the transition settles.
  onLayoutChange();
  setTimeout(onLayoutChange, 220);
}

export function hideDrawer() {
  document.getElementById("drawer").classList.remove("open");
  applyMode();
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
  onLayoutChange();
  setTimeout(onLayoutChange, 220);
}
