# The site

`site/` is a static page with no build step. Open `site/index.html` over any HTTP server
and it runs; GitHub Actions publishes the directory as-is.

```bash
python3 reservoir_stats.py --out site/data/summary.json   # build the data first
python3 serve.py                                          # then open 127.0.0.1:8765
```

Use `serve.py` rather than `python3 -m http.server`: the latter sends no `Cache-Control`,
so a browser reuses cached ES modules and an edit lands as a mix of old and new files.
That failure looks like an application bug, not a stale cache.

`file://` will not work — the page fetches `data/summary.json`, and ES modules and `fetch`
both need an origin.

## Layout

```
site/
  index.html          markup, in document order: filters, Overview, Graph, All packages, footer
  css/tokens.css      design tokens, verbatim from the design handoff. Do not edit.
  css/app.css         layout and components
  js/dom.js           the class palette, formatting, SVG helpers, tooltip, aria-live
  js/state.js         application state and URL-hash serialisation
  js/world.js         THE DATA LAYER — read this first
  js/charts.js        composition, mix-over-time, ranking, line chart
  js/graph.js         the force-directed dependency graph, on canvas
  js/table.js         All packages
  js/drawer.js        the package detail panel
  js/main.js          boot, the single render entry point, all event wiring
  data/summary.json   built by reservoir_stats.py; not tracked in git
```

## Why vanilla ES modules and not React

The design handoff specifies React, and explicitly invites disagreement. This is the one
place the implementation takes it up.

The handoff shipped a complete single-file vanilla prototype implementing the entire spec,
already through two rounds of design and usability review. Its data layer is the fix for
the app's worst bug class, and its charts already encode a dozen decisions that a chart
library's defaults would silently undo. Porting that into modules keeps all of it. Rewriting
it in React would have re-litigated every one of those decisions in a new idiom, for a page
that fetches one JSON file and renders it.

Against that, React would buy component reuse across the three views, but they share one
drawer and the drawer is a function that fills a panel. There is no
server-side rendering, no per-user state, no routing beyond a hash, and no team splitting
the work. So the cost of a bundler, a dependency tree to keep current, and a build step in
CI has nothing to pay for it. `git clone && python3 && open` is the whole toolchain.

The one thing given up is that adding the backlog's heavier views, such as the
toolchain-lag heatmap, means hand-rolling more SVG. If several of those get built, revisit
this.

## The rule the whole app is arranged around

From `js/world.js`, and it is the reason the numbers here can be trusted:

> Dependency counts are computed over the **whole** graph at the selected month.
> Filters decide what is **displayed**, never what is **counted**.

Two layers, which must not be collapsed into one:

- `world(t)` — every package alive at month `t`, its edges among those packages, its class,
  its dependent count. Memoised per month.
- `inScope(n)` — the star and class filters, applied on top, for display and for counts *of
  packages*, never for counts of edges *into* a package.

An early build in review filtered first and computed second. At "min stars 100+" it
reported that `aesop` had zero dependents, because every package depending on `aesop` had
been deleted from the graph before counting. The scope bar under the filter row exists to
state this out loud, and if the scope bar and the screen ever disagree that is a P0.

Verified by measurement, not inspection: at min-stars 100+, `mathlib` still reports 478
dependents and `aesop` still reports 26.

### The control bar is split on that same line

Two labelled rows, and the split is not decoration:

| Row | Contains | What it does |
|---|---|---|
| **Scope** | As of, Min stars, the four class chips, On Palomar, Has formalization.yaml | goes through `inScope`; changes which packages are counted |
| **Find** | Jump to a package | narrows the All packages table; dims or highlights elsewhere |

Everything used to sit in one wrapping row as identical pills, Hide Mathlib among them.
That read as "drop Mathlib from the data", which is the opposite of what it does. It has
since moved out of this bar entirely; see below.

### Three weights, in reading order

The tab strip, the control panel and the content cards were all the same object: filled
with `--surface`, one-pixel bordered, rounded. Stacked, that gave the top of the page three
interchangeable-looking panels and no hierarchy, and the tab strip in particular got the
same treatment as `.seg`, the segmented control inside the graph — so page navigation looked
like a toggle sitting among controls.

| Band | Chrome | Why |
|---|---|---|
| Tabs | none; text with a 2px underline on the selected one | navigation, drawn as navigation |
| Filter panel | outline only, filled with `--plane` (the page colour) | controls, recessed rather than raised |
| Content | filled `--surface` card | the only thing on the page that is data |

The underline overlaps the strip's own hairline (`margin-bottom: -1px`) so the indicator sits
*on* the rule rather than below it. The global `:focus-visible` ring still lands on the tabs,
checked with real Tab keypresses rather than `.focus()`, which does not set keyboard modality
in Chrome.

### A control belongs to the view it changes

Hide Mathlib (called Collapse Mathlib until it was measured) sat in the page's control bar
for three views and earned its place in one:

| View | What pressing it did |
|---|---|
| Graph | removed Mathlib and its 47% of all edges, and in focus mode re-centred on the next real hub |
| Overview | deleted the ranking callout naming Mathlib, and revealed rank 13 |
| All packages | nothing at all, while the scope bar asserted "Mathlib is excluded from the ranking" with `mathlib` sitting in row 1 |

The Overview case is the interesting one. Its stated purpose is scale: one package with 7x
the dependents of the next flattens every other bar. True, and `drawTop` already fixes it
by charting a runaway leader in its own callout (`rows[0] >= rows[1] * 2.5`; Mathlib is 478
against 78). **The bars never contained Mathlib either way**, so the filter could not
improve the scale. Measured: callout `mathlib 478 dependents · 59% of every package` and 12
bars with it off, no callout and 13 bars with it on. Information removed, not scale
regained.

So it now lives in the graph's own controls, beside the mode switch, and outside
`#allOnlyTools` because hiding Mathlib matters in both graph modes where hide-orphans only
matters in one. `renderRanking` filters nothing. The scope-bar sentence is graph-only and
reads like the hide-orphans one next to it. The `m=1` hash key is kept through the rename so
existing deep links resolve; on Overview or All packages it now correctly claims nothing.

### "Share of the ecosystem" was a share of the scope

`charts.js` computed `pct(v, total)` where `total` is the **scoped** count, then labelled it
"of the ecosystem", in the composition bar tooltip, the donut tooltip, and the mix-over-time
caption. Under the formalization.yaml filter that printed `1 pkgs · 50% of the ecosystem`
for a package that is 0.1% of the ecosystem. All three now say "of packages in scope",
which is what the number is in every case, filtered or not. Same family as the 1811%
callout below: a denominator that quietly changed identity under a filter.

Two layout details worth keeping: each row is a grid with the label in its own column, so a
Scope row that wraps indents its second line under the controls rather than sliding back
under the label; and a `.vr` separator that has wrapped to the start of a line is hidden,
because it would be a rule against nothing.

## Things that look like they could be simplified but cannot

- **Ranking bars are all one neutral ink.** They were coloured by class once and it was
  reversed in review: bar length is the only quantitative encoding and the class must not
  distort it. The class rides a 9px swatch beside the name.
- **The fourth class is a solid gray fill everywhere.** Drawn as a dashed outline once,
  which produced two bars of *identical length* — 15 and 15 — reading as different
  magnitudes.
- **The class palette's order is a colourblind-safety property**, validated for all-pairs
  separation under three kinds of CVD in both themes. Reordering it or substituting a
  library's default categorical scale breaks that silently. See the handoff's
  `02-DESIGN-SYSTEM.md`.
- **Every chart has a table form.** That is the mechanism making colour-encoded and
  hover-gated values reachable, and it is the narrow-screen fallback. Not optional.
- **`min-width: 0` on every grid child.** Without it a wide table refuses to shrink and
  pushes horizontal overflow onto the whole page — measured at 178px of drift at a 390px
  viewport in the prototype.
- **`inert` and `aria-modal` are set together, or not at all.** `inert` is what gives focus
  containment and background-hiding, and it is the only thing that makes `aria-modal="true"`
  honest. Declaring the second without the first tells assistive tech the page behind does
  not exist while Tab still goes there. So the detail panel sets both only when it is
  overlaying (below 1000px), and neither when it is docked.
- **The Palomar chip disappears when the feed brought nothing back.** A build whose
  Palomar fetch failed, or whose feed named no indexed package, would otherwise leave a
  control whose only possible effect is to empty every view. `main.js` hides it and
  clears the state a deep link may have set, so `#pl=1` on a Palomar-less build is a
  no-op rather than a blank dashboard.
- **The Palomar chip goes through `inScope`, not through the render.** It is a scope
  filter like min stars, so the same rule holds: with it on, `mathlib` still reports 478
  dependents. What it must never become is a filter applied before counting.
- **"Has formalization.yaml" is the same kind of chip, with the same two guards.** It goes
  through `inScope`, and it is hidden with its state cleared on a build where no package
  carries the file — which includes any build whose GitHub sweep was skipped for want of a
  token, not just an empty ecosystem.
- **A new scope filter has to join `mixSeries`'s memo key.** That series is memoised on the
  filter tuple, not on `asof`, because it is a prefix. Adding `formalizationOnly` to
  `inScope` and not to the key leaves the mix-over-time chart showing the *previous* scope
  until some other filter moves: Nov 23 kept reading 96 packages when the filtered answer
  is 0. Any future filter has the same trap.
- **The file is named, never paraphrased.** The chip, the badge, the panel heading and the
  table column all read `formalization.yaml`, because the reader's next move is to go and
  open that file in the repository. "Declared formalization" described the same thing while
  hiding the one string they can act on.
- **No `localStorage`.** In-memory state plus the URL hash, so the page stays embeddable
  and a view stays shareable.

## Departures from the handoff

Beyond the stack, four:

1. **No Hubs KPI tile.** The spec's KPI row has five tiles; this has four. Removed on
   request. `HUB_MIN` still drives the graph's hub rings, labels and keyboard navigation,
   so the concept is intact, just not counted on the Overview.
2. **No code-size chart in the drawer.** The registry publishes no declaration counts. The
   contract says to ship the field null and hide the chart rather than interpolate, so the
   drawer has one chart instead of two, and the footer says why.
3. **The build badge names the toolchain.** "Builds on latest toolchain" would be untrue:
   Reservoir builds each package against the toolchain *that package pins*, and the
   population is spread across dozens. The badge reads "Builds on v4.32.1", with a separate
   "Behind the newest toolchain" when it is. See `docs/DATA.md`.
4. **The table's Declarations column is Toolchain instead**, for the same reason.

## Palomar, and saying what the data cannot

The two things on the page that do not come from the Reservoir index: entries in the
[Palomar](https://palomar-registry.org) registry of Lean-verified results, joined to the
package whose repository they cite. A filter chip scopes the app to those packages, and
the detail panel lists their entries with a badge above.

The trap is that the source is `recent.json`, a feed of the newest registrations rather
than the whole registry — currently ten entries, of which two match an indexed package.
So an empty result means "not in the recent feed", and the UI is not allowed to let that
read as "not on Palomar". Both the scope bar and the panel's caption say so in words, for
the same reason the scope bar exists at all. See `docs/DATA.md`.

The panel puts the section above the adoption chart. It is the strongest claim on the
panel — what this repository *proves* — and below the charts it would sit under thirty
dependent pills.

### formalization.yaml, which is a claim rather than a record

Directly below Palomar, the panel shows what the repository's own `formalization.yaml`
declares, with a link to the file itself — every claim in the section is checkable only
against it, and `/blob/HEAD/` lets GitHub resolve the default branch we do not store.
22 of 808 packages have the file.

Everything the file supplies, and nowhere else on the panel:

| Row | From |
|---|---|
| the paragraph under the caption | `project.description`, shown only when it differs from the index's own description |
| Declared name | `project.name`, shown only when it differs from the package name |
| Sorry | `status.sorry_count`, with `sorry_in_definitions` appended |
| Axioms | `status.axioms` |
| Repository role | `repository.role` |
| Produced by | `automation.methods[].method`, deduplicated |
| Review | `review.status` |
| Declared license | `project.license`, which is the file's claim and not what GitHub reports |
| Authors | `project.authors`, first six then a count |
| Classified | `classification.arxiv` and `classification.msc2020`, merged |
| Scope | `status.scope` |
| Main results | `status.main_results[]`: declaration, file, per-result sorry count |
| Sources | `sources[]`: title, type, relationship, and the id as a link when it is an arXiv URL or a DOI |

The badge above the fact list is `status.sorry_count` again, because it is the one thing a
reader scanning the panel wants first.

Finding them does not require opening 808 panels: the **"Has formalization.yaml"** chip
scopes the whole app to those packages, and the **All packages** table's last column sorts
them together. The column separates "declared, no sorry" from a bare "declared" for the
same reason the badge does.

It sits next to Palomar because the two answer the same question from opposite ends, and
that is exactly why it does not look like the sections around it. Every other section on
the panel is measured from the Reservoir index; every word in this one is copied out of a
file in the package's own repository. So it is fenced in its own box, with a left rule, a
`self-reported` tag on the heading, and a caption that reads "Read as a claim, not a
check". Styling it like the measured data would invite a reader to trust the two equally.

**It collapses.** A `<details>`, so keyboard support is native and there is no toggle state
to re-apply; PFR's entry is 2,000px of prose and a reader who does not want it should be
able to fold it away. Open by default, because fetching the file and then hiding it would
be pointless. Whether it is open is remembered in a module variable for the session: the
drawer body is rebuilt on every render, so without that, collapsing the box and then
nudging the month slider would silently re-expand it. Not in the URL — it is a reading
preference, not scope.

Two absences are never allowed to read as answers:

- **No file is not "not formalized."** 786 repositories have none, which says nothing about
  what they prove.
- **No declared `sorry_count` is not zero.** A file that states one earns the green "no
  sorry" badge; a file that says nothing gets the plain "formalization.yaml".

Every field is optional in practice, whatever the schema requires, so anything the file
does not set is simply not drawn. A `v0.3` file with four keys renders as four rows rather
than as a table full of "unknown".

## The detail panel docks rather than overlays

Above 1000px the panel pushes the page aside instead of floating over it behind a scrim.
That is not cosmetic: the point of the panel is to read a package while still seeing and
clicking its neighbours in the graph, and an overlay that dims the page and marks it
`inert` makes exactly that impossible.

The consequence is that above the breakpoint the panel is **not modal**, deliberately. No
scrim, no `inert`, no `aria-modal`, and focus is not contained. Below 1000px there is no
room to push, so it reverts to a real modal overlay with all three.

Two things follow that are easy to get wrong:

- The page's usable width changes without a `resize` event firing, and canvas charts size
  from their container, so opening and closing the panel has to trigger a re-measure.
- Focus moves to the panel heading only on the *first* open. Doing it on every package
  would yank focus off the graph canvas mid-navigation, which is the thing docking exists
  to prevent.

### Widen, for reading one package instead of comparing it

A **Widen** button beside Close takes the docked panel from 440px to
`min(980px, 62vw)` — enough for the whole of a `formalization.yaml` entry without
scrolling past it in a 440px column. **Narrow** puts it back.

Four details, each of which is the reason it is a class on `<body>` rather than a width on
the panel:

- The width is a CSS variable that both the panel and the body's `padding-right` read, so
  one class moves both and the page is *reflowed* rather than covered. Widening never turns
  the docked panel into an overlay.
- It re-measures the canvas, twice, for the same reason opening the panel does: the
  container is still mid-transition on the first call. Widening while the graph is open
  visibly shrinks the graph and the graph keeps working.
- The override is scoped inside the `min-width: 1000px` block. Below the breakpoint the
  panel is already a 94vw overlay, so there is nothing to widen into; the button is hidden
  there rather than left to do nothing.
- At 980px a paragraph would run to about 140 characters, so prose and the fact grid are
  held to `78ch`. The extra width is for the pill lists and the declaration boxes, which
  use all of it.

The label says what the button will do next rather than carrying `aria-pressed` with a
fixed label: "Widen"/"Narrow" needs no second channel to be understood. Like the
`formalization.yaml` box's open state, it lives in a module variable and not in the URL —
it is how one reader wants to read, not something a shared link should impose.

## The graph

Built, and it confirms the complaint the handoff raised against it. On real data 672 nodes
are drawn with 1,010 edges, Mathlib sits in the middle with 478 leaves hanging off it, and
the overwhelming majority of nodes are at the minimum radius because they have no
dependents at all. It is a good poster of a star topology.

What makes it answer questions rather than just look like something is the ego lens:
selecting a package lights it and its direct neighbours, dims everything else, and the note
says "Showing X and its N neighbours" with a Show all button. The reviewer's suggestion to
make that neighbourhood view the *default*, with the full hairball as an opt-in, is still
the better product and is still not done.

Two things in it are deliberately not the prototype's:

- **Re-layout is deterministic.** The prototype scattered nodes with `Math.random()`, so
  pressing it twice on the same node set gave two different pictures. It now scatters onto
  a ring by index, which makes the button a reset rather than a dice roll. Same for the
  degenerate case of two exactly coincident nodes, which needs *some* direction to
  separate along and now picks one from the nodes' own radii.
- **Label priority is deterministic.** The prototype's candidate order let the set of
  dropped labels shift between frames. Candidates are now ego neighbourhood, then search
  matches, then hubs, each ordered by dependents, so the same picture always drops the same
  labels. The handoff lists this as a known issue worth fixing.

`prefers-reduced-motion` skips the animation and renders the settled layout directly, which
is what the accessibility spec asks for. Measured: with it set, the layout is already static
250ms after arriving at the tab.

The search box remains a finder rather than a scope, which the handoff flagged as a known
rough edge. It is relabelled "Jump to a package…" and the scope bar states that the table
is filtered while the charts are not — the reviewer's second suggestion. Making it scope
everything is still an open option.

## Verifying changes

The checklist in the handoff's `07-REVIEW-CHECKLIST.md` is written as things to measure.
The load-bearing ones, all of which have been run against this build:

| Check | Expected |
|---|---|
| Min stars 100+ | `mathlib` 478 and `aesop` 26, unchanged |
| Palomar chip on | same 478 and 26; scope bar states the feed is not the registry |
| Palomar chip on a build with no entries | chip hidden, `#pl=1` ignored, dashboard unchanged |
| "Has formalization.yaml" chip on | 22 of 808 in scope, `mathlib` still 478 elsewhere, `#fz=1` in the hash |
| The same chip, mix-over-time chart | Nov 23 recomputes to 0 rather than staying at 96 |
| The same chip on a build with no files | chip hidden, `#fz=1` ignored, dashboard unchanged |
| Panel for a package with `formalization.yaml` | section present, declarations named, "no sorry" only when declared `0` |
| Panel for a package without one | no section, no badge, no empty heading |
| Panel for a `v0.3` file with four keys | only those four rows, nothing rendered as "unknown" |
| Collapsing the box, then moving the slider | stays collapsed, and stays collapsed for the next package opened |
| Widen with the graph open | panel 440px → 930px at 1500px wide, canvas re-measures 995px → 505px, graph still live |
| Widen below 1000px | button hidden, panel stays a 440px overlay |
| Ranking callout share with filters on | ≤100% (it printed 1811% once) |
| Every control after the Scope/Find split | class chip 808→626, min stars 100+ →62, slider back 6 months →59 of 596, both attribute chips still write their hash keys |
| Hide Mathlib, per view | visible and effective only on Graph; hidden on Overview and All packages, where `#m=1` changes nothing and claims nothing |
| Composition tooltips under a filter | "% of packages in scope", never "of the ecosystem" |
| Slider back 12 months | composition, mix and both line charts all end at the same month |
| Tabbable count, drawer closed | ~24, none of them inside the drawer |
| Tabbable count, panel open, below 1000px | zero outside the panel, `inert` and `aria-modal` set |
| Tabbable count, panel open, docked | page stays reachable, no `inert`, no `aria-modal` |
| Opening the panel while docked | canvas re-measures to the narrower width |
| Enter on a table row, then Escape | focus returns to that exact row |
| Back with the drawer open | closes the drawer, stays on the page |
| `documentElement.scrollWidth` at 390px | equal to `innerWidth` |
| Console across 4 viewports × 2 themes | zero errors and zero warnings |
| Drag a node ~100px, release | drawer does **not** open; a click without moving does |
| Arrow keys on the focused canvas | `aria-live` announces a different hub each press |
| Graph below 700px | replaced by the fallback card, canvas not rendered |
| `prefers-reduced-motion: reduce` | layout settled within 250ms, transitions 0s |

There is no test runner. These were driven in headless Chrome over CDP; a short driver
script is the cheapest way to re-run them and reasoning about them instead is how they got
shipped broken the first time.
