# The data behind Reservoir Stats

`reservoir_stats.py` writes one file, `site/data/summary.json`, and the site consumes
nothing else. This document is the normative description of that file, and of where it
departs from the front-end handoff's `04-DATA-CONTRACT.md`.

## Where the numbers come from

Everything is derived from [`leanprover/reservoir-index`][index], the git repository that
backs reservoir.lean-lang.org. Per package it stores

```
<owner>/<name>/metadata.json   repo URL, stars, license, createdAt, updatedAt
<owner>/<name>/versions.json   one dated entry per indexed version, each carrying the
                               dependencies Lake resolved from that version's lakefile
<owner>/<name>/builds.json     one dated entry per build attempt, with its toolchain
```

No other source is used. No GitHub API calls, so no tokens and no rate limits.

[index]: https://github.com/leanprover/reservoir-index

## How the history is reconstructed

The site has a month slider covering the registry's whole life, which needs a graph per
month. That is reconstructible from a *single* daily snapshot, because `versions.json`
retains every indexed version with its date and its own dependency list — mathlib has
110 entries going back to August 2023. So:

> The graph at month M is every package indexed by M, wired up with the dependencies of
> its newest version dated at or before M.

There is no need to walk the index's git history for edges, and no need to accumulate
snapshots going forward. A fresh clone reproduces the full history.

### The one thing versions.json cannot tell us

When a package **entered the registry**. Neither obvious source works:

- `metadata.json`'s `createdAt` is when the GitHub *repository* was created. Mathlib's is
  2021, years before Reservoir existed.
- The oldest entry in `versions.json` is when the oldest *retained* version was built.
  558 of ~805 packages retain exactly one version entry, so for most of the registry that
  date is a recent rebuild. Using it invents a growth spike in whatever month the last
  build sweep happened to run.

So `first_seen.py` mines it from the index repo's own git history: the commit that first
added `<owner>/<name>/metadata.json`. It writes `data/first-seen.json`, which is
**committed to this repo** and read by the daily build. Regenerate it with the
`backfill` workflow when it drifts (new packages fall back gracefully — see below).

That script needs a full clone (~640 MB, ~80 s) and is therefore deliberately *not* part
of the daily build. A `--filter=blob:none` clone is smaller but refetches blobs one at a
time and ends up far slower.

### Renames, and why there are four key spaces

Packages get renamed, and each kind of rename defeats a different key:

| Rename | Example | Defeats |
|---|---|---|
| Index renames the package | `mathlib4` → `mathlib`, `proofwidgets4` → `proofwidgets` | index path |
| GitHub org renames | `lurk-lab` → `argumentcomputer`, 13 packages | repo URL |

`first-seen.json` therefore records four tables, and `reservoir_stats.py` tries them in
this order:

1. `byNodeId` — GitHub's immutable repo id (`sources[].id`, e.g. `R_kgDOFcwZ1Q`).
   Survives both kinds of rename. Covers ~700 of 806 packages.
2. `byRepo` — normalised repo URL. Covers the 213 packages seeded at the index's first
   commit, which predate the `sources[]` schema and have no node id.
3. `byPath` — `<owner>/<name>` as spelled at the time.
4. `byName` — bare package name, **only** where exactly one repo in the whole history
   ever claimed it. 31 names are claimed by more than one and are dropped, because
   guessing there would silently backdate a new package to an unrelated older one.

Anything still unmatched — a package added after the last backfill — falls back to its
oldest retained build date, floored at the index's own first commit. The build prints the
breakdown of which rule matched how many packages; currently 8 of 806 use the fallback.

## Shape

```jsonc
{
  "generatedAt": "2026-08-17T12:00:00Z",   // rendered in the footer, so a stale deploy shows
  "source":   { "index": "...", "indexHead": "...", "firstSeenHeadDate": "2026-08-14" },
  "months":    ["Nov 23", ..., "Aug 26"],  // display labels, oldest first, contiguous
  "monthKeys": ["2023-11", ..., "2026-08"],// the same months, sortable
  "mathlibId": "leanprover-community/mathlib",
  "latestToolchain": "leanprover/lean4:v4.34.0-rc1",
  "declarations": null,                    // see below
  "stats":    { ... },                     // build provenance, for debugging the build
  "packages": [ /* PackageSummary, sorted by id */ ]
}
```

One package:

```jsonc
{
  "id": "leanprover-community/mathlib",    // owner/name; the join key and the URL hash value
  "owner": "leanprover-community",
  "name": "mathlib",
  "firstMonth": 0,                         // index into months; never null
  "deps": ["leanprover-community/aesop", ...],        // direct, declared, current
  "depsHistory": [[0, [...]], [14, [...]]],           // see below
  "stars": 3860,
  "builds": true,                          // the most recent build attempt succeeded
  "toolchain": "leanprover/lean4:v4.34.0-rc1",        // what it was built against
  "toolchainCurrent": true,                // that toolchain is the newest in the registry
  "stale": false,                          // no commit in the trailing 12 months
  "version": "0.3.7",                      // newest non-placeholder tag, else null
  "lastCommit": "Aug 26",                  // month precision only, deliberately
  "license": "Apache-2.0",                 // null, never "", when not declared
  "description": "The math library of Lean 4",
  "repoUrl": "https://github.com/leanprover-community/mathlib4"
}
```

### What is deliberately absent

`dependents` and dependency class are **not** in the file, and must not be added. Both
have to be recomputed at every point in time and over the *unfiltered* graph; shipping
them precomputed is how you get the bug the handoff's `AGENTS.md` opens with, where
filtering to "min stars 100+" reported that `aesop` had zero dependents.

## Departures from `04-DATA-CONTRACT.md`

Six, each with a reason.

### 1. `depsHistory` — added

The handoff models `deps` as a single current array, with the time dimension coming only
from filtering to packages alive at month M. That assumes a package's dependencies never
change. Measured against the real index: of the 247 packages with more than one dated
version, **101 (41%) changed their direct dependency set at least once, and 30 flipped
whether they depend on Mathlib at all.**

Freezing today's dependencies across history would therefore backdate present-day Mathlib
adoption onto 2024 and make the composition-over-time chart show a flatness that is an
artifact of the data model. Since the real per-month answer is free, the file ships it:

```jsonc
"depsHistory": [[0, ["a/b"]], [14, ["a/b", "c/d"]]]
```

Offsets are **from the package's own `firstMonth`**, and list only the months where the
set *changed* — most packages have exactly one entry. To get the dependencies at month M:
take the last change point whose `firstMonth + offset <= M`. `deps` is kept as the current
set, so a reader that ignores `depsHistory` still behaves exactly as the contract says.

### 2. The dep-ordering invariant is enforced per month, not globally

The contract says to drop any dependency whose `firstMonth` is later than the dependent's.
That rule exists because static `deps` plus `firstMonth` filtering would otherwise show an
edge in months before its target existed. With `depsHistory` the stronger and more accurate
rule applies: at each change point, drop dependencies not yet indexed **at that month**.
This keeps legitimate cases the contract's version would have discarded — a 2024 package
adding a dependency on a 2026 package is real, and shows up in 2026.

Self-references and duplicates are dropped outright. `reservoir_stats.py` re-checks all of
this after building and exits non-zero rather than shipping a file that violates it.

### 3. No `series.json`

The contract splits per-package time series into a lazily-fetched second file, on the
grounds that recomputing 36 snapshots for 900 packages client-side might be too slow. It
isn't — memoised, the full 34-month recomputation is a few milliseconds — so `adoption[]`
is computed in the browser and the second artifact does not exist. One less file to build,
version and keep consistent.

### 4. `declarations` is null, and the chart is hidden

The index carries no declaration counts, and there is no cheap honest way to get
historical ones. Per the contract's own instruction, the field ships as `null` and the
drawer's code-size chart is not rendered. It is not interpolated.

This is a real loss: the drawer has one chart instead of two.

### 5. `builds` means "the last build attempt succeeded", not "builds on latest toolchain"

The handoff wants a prominent "builds on latest toolchain" badge, on the correct reasoning
that Lean releases are breaking and so this is a strong liveness signal. But Reservoir
builds each package against the toolchain **that package pins**, not against the latest
release — the population is spread over dozens of toolchains, with v4.32.1 the most
common. So a boolean "builds" cannot carry the meaning the badge claims.

The file therefore ships three fields instead of one: `builds` (the last attempt
succeeded), `toolchain` (what it was built against), and `toolchainCurrent` (that
toolchain is the newest seen anywhere in the registry). The drawer shows the pin, so the
badge says something true.

### 6. `repoUrl` and `description` — added

Not in the contract, but the product spec requires the drawer to link to the repository
("a developer's next action is always go look at the repo"), and that needs the URL.

## Known limits, to state in the UI rather than bury

- **The index begins Nov 2023, with 213 packages seeded at once.** So the ecosystem-size
  curve opens with a vertical step. That step is the *registry's* birth, not the
  ecosystem's, and the chart has to say so or it reads as explosive early growth.
- **Removed packages are invisible.** 922 index paths have existed; 806 exist now. The
  history is reconstructed from packages present *today*, so a package indexed in 2024 and
  removed in 2025 appears in no month at all. Every count is therefore of survivors, which
  slightly understates the past. `stats.packages_removed_since_2023` records the size of
  the gap.
- **Dependency resolution is not perfect.** Deps are matched to registry packages by repo
  URL, then scope+name, then bare name only when unambiguous. `reservoir_deps.py` writes
  per-edge provenance to `output/dependencies.csv` if you want to audit which rule matched
  what.
- **`lastCommit` is month precision** because `updatedAt` is a push time and day-level
  precision would invite questions the data can't answer.

## Rebuilding

```bash
python3 reservoir_stats.py                  # site/data/summary.json, ~0.5s from cache
python3 reservoir_stats.py --refresh        # re-download the index first (~4s)
python3 first_seen.py                       # data/first-seen.json, full clone, ~90s
python3 first_seen.py --repo ~/src/reservoir-index    # reuse an existing clone
```

Standard library only, no install step. The daily workflow runs the first of these; the
`backfill` workflow runs the third.
