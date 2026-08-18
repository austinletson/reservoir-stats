# reservoir-analysis

Dependency statistics for [Reservoir](https://reservoir.lean-lang.org), the Lean 4 package
registry — as a website and as a set of standalone scripts.

## Reservoir Stats, the site

A static dashboard answering: what the ecosystem is built on, how it is composed, how it is
growing, and whether a given package is alive and load-bearing. Three views (Overview, a
force-directed dependency Graph, and All packages) over a month slider covering the
registry's whole history, with a detail panel per package.

Rebuilt and redeployed daily by [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
No build step, no dependencies, no server.

```bash
python3 reservoir_stats.py            # build site/data/summary.json
python3 serve.py                      # then open http://127.0.0.1:8765
```

- [`docs/DATA.md`](docs/DATA.md) — what `summary.json` contains, how 34 months of history
  are reconstructed from one daily snapshot, and the six places it extends the front-end
  design contract.
- [`docs/UI.md`](docs/UI.md) — how the page is put together, why it is vanilla ES modules,
  and which apparent simplifications would actually be regressions.

| script | what it does |
| --- | --- |
| `reservoir_stats.py` | builds `site/data/summary.json` — the whole site's data, per-month |
| `first_seen.py` | mines when each package entered the index, from the index's git history |
| `reservoir_deps.py` | the original point-in-time graph dump, described below |

## reservoir_deps.py

`reservoir_deps.py` walks every package on Reservoir and emits the dependency graph between
them, as CSV, JSON, Graphviz DOT and a readable report. It is standalone and unchanged by
the site; `reservoir_stats.py` reuses its dependency-resolution logic.

## Where the data comes from

Reservoir publishes its index as a git repository,
[leanprover/reservoir-index](https://github.com/leanprover/reservoir-index), laid out as
`<owner>/<name>/{metadata.json,versions.json,builds.json}`. Each entry in `versions.json`
lists the dependencies Lake resolved for that version, flagged as either

- `"transitive": false` — required directly by the package's lakefile, and
- `"transitive": true` — pulled in by one of those dependencies.

So the lakefile requires are already resolved for us; no cloning or lakefile parsing is
needed. The script downloads the index (≈4 s, cached under
`~/.cache/reservoir-analysis/`), reads the newest indexed version of each package, and
maps every dependency back to the Reservoir package it refers to.

## Usage

```bash
python3 reservoir_deps.py                       # direct (lakefile) deps -> ./output
python3 reservoir_deps.py --refresh             # re-download the index
python3 reservoir_deps.py --include-transitive  # also edge transitive deps
python3 reservoir_deps.py --include-external    # keep deps on repos not on Reservoir
python3 reservoir_deps.py --index-dir ~/src/reservoir-index   # use a local checkout
python3 reservoir_deps.py --help
```

Standard library only — no install step, no dependencies.

## Output (`./output`)

| file                        | contents                                                                       |
| --------------------------- | ------------------------------------------------------------------------------ |
| `most-used-libraries.md`    | the readable report: both rankings, plus index stats and caveats                |
| `dependents.csv`            | libraries ranked by **direct** dependents, with the full dependent list         |
| `dependents_transitive.csv` | the same ranking counting transitive dependents too                             |
| `graph.json`                | `{stats, nodes, edges}` — nodes carry stars, license, toolchain, degrees        |
| `dependencies.csv`          | one row per edge: source, target, dep name/scope, rev, inputRev, url            |
| `packages.csv`              | one row per package with its in/out degree                                      |
| `graph.dot`                 | Graphviz — `dot -Tsvg output/graph.dot -o reservoir.svg`                        |

Both rankings and the report are written on every run regardless of
`--include-transitive`; that flag only decides whether transitive edges land in the
graph itself (`graph.json`, `dependencies.csv`, `graph.dot`). The rankings are also
printed at the end of a run — `--top N` sets how many rows, `--top 0` prints all.

`output/` is gitignored apart from `most-used-libraries.md`, which is worth tracking so
changes to the ecosystem show up in diffs.

## Dependency resolution

Each dependency is matched to an indexed package by, in order:

1. **repo URL** (normalised: scheme, `git@host:`, `www.`, `.git`, trailing `/`) — the
   great majority of matches;
2. **scope + name**, where Reservoir's scope is the repo owner;
3. **bare name**, but only when exactly one indexed package claims that name (16 names
   are claimed by two owners, e.g. `render`, `cryptolib`, so ambiguous ones are skipped).

Every edge records which rule matched it in `resolvedBy`, so you can filter out the
name-based guesses if you want a URL-only graph.

Dependencies that match nothing are repos not indexed by Reservoir (e.g. `std`,
`hhu-adam/GameServer`). They are dropped unless `--include-external`, which adds them as
`external:<url>` nodes. `require ... from` local path dependencies point at in-repo
subdirectories and are skipped unless `--include-path-deps`.

## Rough shape of the graph

As of the current index: 806 packages, ~1000 direct-dependency edges, 180 packages with
no dependencies at all, and 119 libraries with at least one dependent. It is a very
long tail — 64 of those 119 are used exactly once, while the top of `dependents.csv` is

| library                            | used by |
| ---------------------------------- | ------: |
| `leanprover-community/mathlib`     |     478 |
| `PatrickMassot/checkdecls`         |      78 |
| `leanprover/doc-gen4`              |      63 |
| `leanprover-community/batteries`   |      38 |
| `leanprover/Cli`                   |      33 |
| `leanprover-community/aesop`       |      26 |
| `argumentcomputer/LSpec`           |      21 |
| `leanprover-community/Qq`          |      17 |
| `leanprover-community/proofwidgets`|      16 |
| `leanprover/verso`                 |      13 |

Counting transitive dependents instead reorders the top: mathlib's own dependencies
overtake it, since everything that pulls mathlib also pulls them — `Cli` 545,
`aesop` 526, `Qq` 525, `proofwidgets` 522, then mathlib itself at 518. So the direct
count says what authors reach for, and the transitive count says what is actually in
everyone's build. Full tables for both are in
[`output/most-used-libraries.md`](output/most-used-libraries.md).
