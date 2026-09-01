# Reservoir Stats

Dependency statistics for [Reservoir](https://reservoir.lean-lang.org), the Lean 4 package
registry: what the ecosystem is built on, how it is composed, and how it is growing.

**[reservoir-stats.austinletson.com](https://reservoir-stats.austinletson.com)**

Rebuilt and redeployed daily by GitHub Actions. Static site, no build step; the builders
need PyYAML and nothing else.

## Locally

```bash
just deps                    # PyYAML, the one dependency
just run                     # build the data, then serve at http://127.0.0.1:8765
just serve                   # serve without rebuilding
```

Or without `just`: `python3 -m pip install -r requirements.txt`, then
`python3 reservoir_stats.py` and `python3 serve.py`.

Use `serve.py` rather than `http.server`: the latter lets browsers cache ES modules, so
editing one file serves a stale mix of old and new.

A cold build reads `formalization.yaml` from all 808 package repositories, which needs an
authenticated GitHub budget: `GITHUB_TOKEN=$(gh auth token) just build`. Without a token
that data is skipped with a warning rather than half-collected. Later builds only ask about
repositories the index says were pushed to, so they need no requests at all.

## What is here

| | |
| --- | --- |
| `site/` | the site: three views over a month slider covering the registry's whole history |
| `reservoir_stats.py` | builds the site's data, reconstructing a dependency graph per month, and joins in [Palomar](https://palomar-registry.org) registry entries and each repository's [`formalization.yaml`](https://github.com/mathlib-initiative/formalization.yaml) |
| `first_seen.py` | mines first-indexed dates from the index's git history. Occasional, not daily |
| `reservoir_deps.py` | standalone point-in-time graph dump, as CSV, JSON and Graphviz |
| [`docs/DATA.md`](docs/DATA.md) | the data shape, how the history is reconstructed, and what it cannot say |
| [`docs/UI.md`](docs/UI.md) | how the page works, and which apparent simplifications are regressions |

[`output/most-used-libraries.md`](output/most-used-libraries.md) is a tracked report, so
changes to the ecosystem show up in diffs.
