#!/usr/bin/env python3
"""Build the data file behind the Reservoir Stats site.

`reservoir_deps.py` answers "what does the dependency graph look like *now*". This
script answers "what did it look like in each of the last N months", which is what the
site's time slider, growth deltas and composition-over-time chart need.

The history is reconstructible from a single daily snapshot of the index, because
`versions.json` retains one entry per indexed version, each dated and each carrying the
dependency list Lake resolved for it. So the graph at month M is: every package indexed
by M, wired up with the dependencies of its newest version dated at or before M.

What the index cannot tell us is when a package *entered the registry* — see
`first_seen.py`, which mines that from the index repo's git history and writes
`data/first-seen.json`. This script reads that file.

Output: `site/data/summary.json`. See `docs/DATA.md` for the shape and for where it
extends the front-end handoff's contract.

Usage:
    python3 reservoir_stats.py                     # fetch index, write site/data/summary.json
    python3 reservoir_stats.py --refresh           # re-download the index first
    python3 reservoir_stats.py --index-dir ~/src/reservoir-index
    python3 reservoir_stats.py --out site/data/summary.json

Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from reservoir_deps import (
    DEFAULT_CACHE,
    Package,
    Resolver,
    _read_json,
    fetch_index,
    iter_package_dirs,
    normalize_git_url,
)

MATHLIB_ID = "leanprover-community/mathlib"
STALE_MONTHS = 12


# --------------------------------------------------------------------------- months


def month_ord(year: int, month: int) -> int:
    return year * 12 + (month - 1)


def ord_of_iso(iso: str | None) -> int | None:
    """Month ordinal of an ISO date/timestamp, or None if it isn't one."""
    if not iso or len(iso) < 7:
        return None
    try:
        return month_ord(int(iso[0:4]), int(iso[5:7]))
    except ValueError:
        return None


def label_of_ord(o: int) -> str:
    """"Nov 23" — the month labels the UI shows on axes and the time slider."""
    year, month = divmod(o, 12)
    return f"{dt.date(year, month + 1, 1):%b %y}"


def key_of_ord(o: int) -> str:
    """"2023-11" — a sortable machine key, kept alongside the display label."""
    year, month = divmod(o, 12)
    return f"{year:04d}-{month + 1:02d}"


# --------------------------------------------------------------------------- load


class IndexedPackage:
    """One package, with its full dated version history rather than a single version."""

    __slots__ = ("meta", "full_name", "name", "owner", "repo_url", "node_id", "versions", "builds")

    def __init__(self, meta: dict[str, Any], versions: list[dict[str, Any]], builds: list[dict[str, Any]]):
        self.meta = meta
        self.full_name: str = meta.get("fullName") or f"{meta.get('owner')}/{meta.get('name')}"
        self.name: str = meta.get("name") or ""
        self.owner: str = meta.get("owner") or ""
        source = (meta.get("sources") or [{}])[0]
        self.repo_url: str | None = source.get("repoUrl") or source.get("gitUrl") or meta.get("url")
        self.node_id: str | None = source.get("id") or None
        # Oldest first, so "newest entry at or before month M" is a scan from the right.
        self.versions = sorted(
            (v for v in versions if v.get("date")), key=lambda v: str(v.get("date"))
        )
        self.builds = builds

    def as_resolver_package(self) -> Package:
        """Resolver only reads full_name and name; this keeps it reusable as-is."""
        return Package(
            full_name=self.full_name,
            name=self.name,
            owner=self.owner,
            description=None,
            license=None,
            stars=0,
            keywords=[],
            homepage=None,
            repo_url=self.repo_url,
            created_at=None,
            updated_at=None,
        )


def _data_list(payload: Any) -> list[dict[str, Any]]:
    """`{schemaVersion, data: [...]}` today, a bare array in older index revisions."""
    if isinstance(payload, dict):
        return payload.get("data") or []
    return payload or []


def load_index(index_dir: Path) -> list[IndexedPackage]:
    packages: list[IndexedPackage] = []
    for pkg_dir in sorted(iter_package_dirs(index_dir)):
        meta = _read_json(pkg_dir / "metadata.json")
        versions: list[dict[str, Any]] = []
        builds: list[dict[str, Any]] = []
        if (pkg_dir / "versions.json").exists():
            versions = _data_list(_read_json(pkg_dir / "versions.json"))
        if (pkg_dir / "builds.json").exists():
            builds = _data_list(_read_json(pkg_dir / "builds.json"))
        packages.append(IndexedPackage(meta, versions, builds))
    return packages


# --------------------------------------------------------------------------- first seen


class FirstSeen:
    """When each package entered the index, from `first_seen.py`'s git-history walk."""

    def __init__(self, data: dict[str, Any] | None):
        data = data or {}
        self.by_node_id: dict[str, str] = data.get("byNodeId") or {}
        self.by_repo: dict[str, str] = data.get("byRepo") or {}
        self.by_path: dict[str, str] = data.get("byPath") or {}
        self.by_name: dict[str, str] = data.get("byName") or {}
        self.head_date: str | None = data.get("indexHeadDate")
        # The index's first commit. Nothing can have been in the registry before it, so
        # this is the floor for every fallback below.
        self.index_start: str | None = data.get("indexStart")

    def date_for(self, pkg: IndexedPackage) -> tuple[str, str]:
        """(ISO date, how we got it). The order is by how much the key can be trusted."""
        if pkg.node_id and pkg.node_id in self.by_node_id:
            return self.by_node_id[pkg.node_id], "node-id"
        norm = normalize_git_url(pkg.repo_url)
        if norm and norm in self.by_repo:
            return self.by_repo[norm], "repo-url"
        if pkg.full_name in self.by_path:
            return self.by_path[pkg.full_name], "index-path"
        if pkg.name.lower() in self.by_name:
            return self.by_name[pkg.name.lower()], "unique-name"
        # Not in the history file at all: added to the index after the last backfill run.
        # Its oldest retained build is the best remaining evidence, floored at the index's
        # own start date so an old repo's old build can't predate the registry.
        if pkg.versions:
            return str(pkg.versions[0]["date"]), "oldest-version"
        return str(pkg.meta.get("createdAt") or ""), "repo-created"


# --------------------------------------------------------------------------- deps


def resolve_entry(
    entry: dict[str, Any], owner_id: str, resolver: Resolver
) -> list[str]:
    """The direct, declared, in-registry dependencies recorded for one version.

    `transitive` deps are what Lake pulled in underneath; the UI's `deps` means what the
    package itself wrote in `require`. Local `path` deps point at in-repo subdirectories
    and are not registry packages at all.
    """
    ids: set[str] = set()
    for dep in entry.get("dependencies") or []:
        if dep.get("transitive"):
            continue
        if (dep.get("type") or "git") == "path":
            continue
        target, _how = resolver.resolve(dep)
        if target is None or target == owner_id:
            continue
        ids.add(target)
    return sorted(ids)


def deps_history(
    pkg: IndexedPackage,
    resolved: list[list[str]],
    first_month: int,
    last_month: int,
    start_ord: int,
    alive: dict[str, int],
    stats: Counter,
) -> list[list[Any]]:
    """Change points: [[monthOffset, [depId, ...]], ...], offsets from `firstMonth`.

    One entry per month the dependency set *changed*, not per month. Most packages have
    exactly one. The client resolves month M by taking the last change point at or before
    it. `first_month`, `last_month` and the returned offsets are all indices into
    `summary["months"]`; `start_ord` converts version dates into that same space.
    """
    if not pkg.versions:
        return [[0, []]]

    # Relative to `months`, matching first_month/last_month. Version dates can predate
    # the index (a package's oldest retained build may be older than the registry), so
    # these can go negative — which is correct: such an entry is in effect from month 0.
    entry_months = [(ord_of_iso(str(v.get("date"))) or start_ord) - start_ord for v in pkg.versions]

    history: list[list[Any]] = []
    cursor = 0  # newest version entry at or before the month being built

    for m in range(first_month, last_month + 1):
        while cursor + 1 < len(entry_months) and entry_months[cursor + 1] <= m:
            cursor += 1
        # A package can enter the index before its oldest *retained* build. Its earliest
        # known dependency list is the honest stand-in; inventing "no dependencies" would
        # read as a real state on the composition chart.
        if entry_months[0] > m:
            stats["months_backfilled_from_oldest_version"] += 1

        # Drop dependencies on packages that did not exist yet: at month M the edge
        # cannot have been resolvable, and the graph must not contain it.
        deps = [d for d in resolved[cursor] if alive.get(d, 1 << 30) <= m]
        stats["edges_dropped_dep_not_yet_indexed"] += len(resolved[cursor]) - len(deps)

        if not history or history[-1][1] != deps:
            history.append([m - first_month, deps])
    return history


# --------------------------------------------------------------------------- build


def latest_toolchain(packages: Iterable[IndexedPackage]) -> str | None:
    """The newest toolchain any package was built against, as a version tuple sort.

    Reservoir builds each package against the toolchain that package pins, so "latest"
    has to be inferred from the population rather than read off a field.
    """
    def key(tc: str) -> tuple:
        tail = tc.split(":")[-1].lstrip("v")
        release, _, pre = tail.partition("-")
        nums = tuple(int(p) if p.isdigit() else 0 for p in release.split("."))
        # No suffix sorts above -rc1: v4.33.0 is newer than v4.33.0-rc1.
        return nums + ((1, "") if not pre else (0, pre))

    seen = {
        b["toolchain"]
        for p in packages
        for b in p.builds
        if b.get("toolchain") and b.get("built")
    }
    return max(seen, key=key) if seen else None


def build_summary(
    packages: list[IndexedPackage],
    resolver: Resolver,
    first_seen: FirstSeen,
    index_head: str | None,
) -> dict[str, Any]:
    stats: Counter = Counter()

    today = dt.datetime.now(dt.timezone.utc).date()
    last_ord = month_ord(today.year, today.month)

    seen_dates = {p.full_name: first_seen.date_for(p) for p in packages}
    # The registry cannot have contained anything before its own first commit. Without
    # this floor, one package whose oldest retained build predates the index (the oldest
    # is 2019) stretches the time axis over years of months in which the registry did
    # not exist and every chart is empty.
    floor_ord = ord_of_iso(first_seen.index_start) or min(
        (ord_of_iso(d) or last_ord for d, _ in seen_dates.values()), default=last_ord
    )
    ords = {
        name: min(max(ord_of_iso(date) or last_ord, floor_ord), last_ord)
        for name, (date, _how) in seen_dates.items()
    }
    if not ords:
        raise SystemExit("no packages found in the index")
    start_ord = min(ords.values())
    n_months = last_ord - start_ord + 1

    # Relative month index, which is what the contract's `firstMonth` means.
    alive = {name: o - start_ord for name, o in ords.items()}
    last_month = last_ord - start_ord

    tc_latest = latest_toolchain(packages)
    stale_cutoff = month_ord(today.year, today.month) - STALE_MONTHS

    out: list[dict[str, Any]] = []
    for pkg in packages:
        first_month = alive[pkg.full_name]
        resolved = [resolve_entry(v, pkg.full_name, resolver) for v in pkg.versions]
        history = deps_history(
            pkg, resolved, first_month, last_month, start_ord, alive, stats
        )

        newest_build = pkg.builds[0] if pkg.builds else None
        toolchain = (newest_build or {}).get("toolchain")
        updated = pkg.meta.get("updatedAt")
        last_commit_ord = ord_of_iso(updated)
        version = next(
            (v.get("version") for v in reversed(pkg.versions) if v.get("version") not in (None, "0.0.0")),
            None,
        )

        stats["packages"] += 1
        stats[f"first_month_from_{seen_dates[pkg.full_name][1]}"] += 1
        if not pkg.versions:
            stats["packages_with_no_indexed_version"] += 1

        out.append(
            {
                "id": pkg.full_name,
                "owner": pkg.owner,
                "name": pkg.name,
                "firstMonth": first_month,
                "deps": history[-1][1],
                "depsHistory": history,
                "stars": pkg.meta.get("stars") or 0,
                "builds": bool((newest_build or {}).get("built")),
                "toolchain": toolchain,
                "toolchainCurrent": bool(toolchain and toolchain == tc_latest),
                "stale": last_commit_ord is not None and last_commit_ord < stale_cutoff,
                "version": version,
                "lastCommit": label_of_ord(min(last_commit_ord, last_ord))
                if last_commit_ord is not None
                else None,
                "license": pkg.meta.get("license") or None,
                "description": pkg.meta.get("description") or None,
                "repoUrl": pkg.repo_url,
            }
        )

    out.sort(key=lambda p: p["id"].lower())
    stats["edges_current"] = sum(len(p["deps"]) for p in out)
    stats["packages_with_dep_changes"] = sum(1 for p in out if len(p["depsHistory"]) > 1)
    stats["mathlib_present"] = int(any(p["id"] == MATHLIB_ID for p in out))
    stats["index_paths_ever_seen"] = len(first_seen.by_path)
    stats["packages_removed_since_2023"] = max(0, len(first_seen.by_path) - len(out))

    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "index": "https://github.com/leanprover/reservoir-index",
            "indexHead": index_head,
            "firstSeenHeadDate": first_seen.head_date,
        },
        "months": [label_of_ord(start_ord + i) for i in range(n_months)],
        "monthKeys": [key_of_ord(start_ord + i) for i in range(n_months)],
        "mathlibId": MATHLIB_ID if stats["mathlib_present"] else None,
        "latestToolchain": tc_latest,
        "declarations": None,  # the index carries no declaration counts; see docs/DATA.md
        "stats": dict(sorted(stats.items())),
        "packages": out,
    }


def check_invariants(summary: dict[str, Any]) -> list[str]:
    """The adapter guarantees the front end is allowed to rely on. Fail loudly here."""
    problems: list[str] = []
    packages = summary["packages"]
    by_id = {p["id"]: p for p in packages}
    n_months = len(summary["months"])

    for p in packages:
        if not 0 <= p["firstMonth"] < n_months:
            problems.append(f"{p['id']}: firstMonth {p['firstMonth']} outside 0..{n_months - 1}")
        for at, deps in p["depsHistory"]:
            for dep in deps:
                target = by_id.get(dep)
                if target is None:
                    problems.append(f"{p['id']}: dep {dep} is not an indexed package")
                elif dep == p["id"]:
                    problems.append(f"{p['id']}: depends on itself")
                elif target["firstMonth"] > p["firstMonth"] + at:
                    problems.append(
                        f"{p['id']}@{at}: dep {dep} first appears at {target['firstMonth']}"
                    )
            if len(set(deps)) != len(deps):
                problems.append(f"{p['id']}@{at}: duplicate dependency")
        ats = [at for at, _ in p["depsHistory"]]
        if ats != sorted(ats) or len(set(ats)) != len(ats):
            problems.append(f"{p['id']}: depsHistory change points not strictly increasing")
    return problems


# --------------------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build site/data/summary.json for the Reservoir Stats site.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--index-dir", type=Path, help="an existing checkout of the Reservoir index")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE, help="where to cache the index")
    parser.add_argument("--refresh", action="store_true", help="re-download the index even if cached")
    parser.add_argument(
        "--first-seen",
        type=Path,
        default=Path("data/first-seen.json"),
        help="output of first_seen.py; without it, firstMonth falls back to build dates",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("site/data/summary.json"), help="where to write"
    )
    parser.add_argument("--quiet", action="store_true", help="skip the summary report")
    args = parser.parse_args(argv)

    index_dir = args.index_dir.expanduser() if args.index_dir else fetch_index(args.cache_dir, args.refresh)
    if not index_dir.is_dir():
        parser.error(f"index directory not found: {index_dir}")

    first_seen_data = None
    if args.first_seen.exists():
        first_seen_data = _read_json(args.first_seen)
    else:
        print(
            f"warning: {args.first_seen} not found — every package's firstMonth will fall "
            "back to its oldest retained build, which invents a growth spike. "
            "Run first_seen.py.",
            file=sys.stderr,
        )

    packages = load_index(index_dir)
    if not packages:
        parser.error(f"no packages found under {index_dir}")
    resolver = Resolver([p.as_resolver_package() for p in packages], index_dir)

    summary = build_summary(
        packages,
        resolver,
        FirstSeen(first_seen_data),
        (first_seen_data or {}).get("indexHead"),
    )

    problems = check_invariants(summary)
    if problems:
        print(f"invariant violations ({len(problems)}):", file=sys.stderr)
        for line in problems[:20]:
            print(f"  {line}", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, separators=(",", ":")) + "\n", encoding="utf-8")

    if not args.quiet:
        stats = summary["stats"]
        size_kb = args.out.stat().st_size / 1024
        print(f"wrote {args.out} ({size_kb:.0f} KB)")
        print(f"  months            : {len(summary['months'])} "
              f"({summary['months'][0]} .. {summary['months'][-1]})")
        print(f"  packages          : {stats['packages']}")
        print(f"  current edges     : {stats['edges_current']}")
        print(f"  changed deps      : {stats['packages_with_dep_changes']}")
        print(f"  latest toolchain  : {summary['latestToolchain']}")
        for key in sorted(k for k in stats if k.startswith("first_month_from_")):
            print(f"  firstMonth via {key[len('first_month_from_'):]:<20}: {stats[key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
