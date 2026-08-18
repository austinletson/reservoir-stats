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
| Ranking callout share with filters on | ≤100% (it printed 1811% once) |
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
