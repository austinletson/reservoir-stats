#!/usr/bin/env python3
"""Build a dependency graph of every package on Reservoir (the Lean 4 package registry).

Data source: the Reservoir index repository, https://github.com/leanprover/reservoir-index,
which is the same data that backs reservoir.lean-lang.org. For each package it stores

    <owner>/<name>/metadata.json   package metadata (repo URL, stars, license, ...)
    <owner>/<name>/versions.json   one entry per indexed version, each with the
                                   dependencies Lake resolved from that version's
                                   lakefile (`transitive: false` = required directly
                                   by the lakefile, `true` = pulled in by a dependency)

This script downloads (or reuses) that index, picks a version per package (the newest
by default), resolves each dependency back to the Reservoir package it refers to, and
writes the graph as JSON / CSV / Graphviz DOT.

Usage:
    python3 reservoir_deps.py                        # fetch index, write ./output
    python3 reservoir_deps.py --refresh              # re-download the index
    python3 reservoir_deps.py --index-dir ~/src/reservoir-index
    python3 reservoir_deps.py --include-transitive   # edges for transitive deps too
    python3 reservoir_deps.py --include-external     # keep deps on non-Reservoir repos

Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

INDEX_TARBALL = "https://codeload.github.com/leanprover/reservoir-index/tar.gz/refs/heads/master"
DEFAULT_CACHE = Path.home() / ".cache" / "reservoir-analysis" / "reservoir-index"
USER_AGENT = "reservoir-analysis/1.0 (+https://github.com/leanprover/reservoir-index)"


# --------------------------------------------------------------------------- fetch


def fetch_index(cache_dir: Path, refresh: bool = False) -> Path:
    """Return a directory holding the Reservoir index, downloading it if needed."""
    marker = cache_dir / "leanprover"  # any owner dir means we have a populated index
    if cache_dir.exists() and marker.exists() and not refresh:
        return cache_dir

    print(f"downloading Reservoir index -> {cache_dir}", file=sys.stderr)
    cache_dir.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(INDEX_TARBALL, headers={"User-Agent": USER_AGENT})
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        archive = tmp_path / "index.tar.gz"
        with urllib.request.urlopen(req, timeout=120) as resp, archive.open("wb") as fh:
            shutil.copyfileobj(resp, fh)
        with tarfile.open(archive, "r:gz") as tf:
            try:
                tf.extractall(tmp_path / "x", filter="data")
            except TypeError:  # Python < 3.11.4 has no extraction filters
                tf.extractall(tmp_path / "x")
        roots = [p for p in (tmp_path / "x").iterdir() if p.is_dir()]
        if len(roots) != 1:
            raise RuntimeError(f"unexpected tarball layout: {roots}")
        if cache_dir.exists():
            shutil.rmtree(cache_dir)
        shutil.move(str(roots[0]), str(cache_dir))
    return cache_dir


# --------------------------------------------------------------------------- model


@dataclass
class Package:
    full_name: str  # "owner/Name" as Reservoir spells it
    name: str
    owner: str
    description: str | None
    license: str | None
    stars: int
    keywords: list[str]
    homepage: str | None
    repo_url: str | None
    created_at: str | None
    updated_at: str | None
    version: str | None = None  # the version the dependencies were read from
    revision: str | None = None
    version_date: str | None = None
    toolchain: str | None = None
    n_versions: int = 0
    deps: list[dict[str, Any]] = field(default_factory=list)  # raw dep records


@dataclass
class Edge:
    source: str  # Reservoir fullName
    target: str  # Reservoir fullName, or "external:<url>"
    dep_name: str | None
    dep_scope: str | None
    dep_type: str
    transitive: bool
    input_rev: str | None
    rev: str | None
    url: str | None
    resolved_by: str  # "url" | "scope+name" | "name" | "external"


def normalize_git_url(url: str | None) -> str | None:
    """Canonicalise a git URL so the same repo spelled different ways compares equal."""
    if not url:
        return None
    u = url.strip().lower()
    u = re.sub(r"^git\+", "", u)
    u = re.sub(r"^git@([^:/]+):", r"\1/", u)
    u = re.sub(r"^(https?://|ssh://(git@)?|git://)", "", u)
    u = re.sub(r"^www\.", "", u)
    u = re.sub(r"\.git$", "", u.rstrip("/"))
    return u.rstrip("/") or None


# --------------------------------------------------------------------------- load


def iter_package_dirs(index_dir: Path) -> Iterable[Path]:
    for dirpath, dirnames, filenames in os.walk(index_dir):
        if ".git" in dirnames:
            dirnames.remove(".git")
        if "metadata.json" in filenames:
            yield Path(dirpath)


def _read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def pick_version(versions: list[dict[str, Any]], strategy: str) -> dict[str, Any] | None:
    """Choose which indexed version's dependency list to use."""
    if not versions:
        return None
    if strategy == "oldest":
        return min(versions, key=lambda v: (v.get("date") or "", v.get("version") or ""))
    return max(versions, key=lambda v: (v.get("date") or "", v.get("version") or ""))


def load_packages(index_dir: Path, version_strategy: str) -> list[Package]:
    packages: list[Package] = []
    for pkg_dir in sorted(iter_package_dirs(index_dir)):
        meta = _read_json(pkg_dir / "metadata.json")
        source = (meta.get("sources") or [{}])[0]
        pkg = Package(
            full_name=meta.get("fullName") or f"{meta.get('owner')}/{meta.get('name')}",
            name=meta.get("name") or "",
            owner=meta.get("owner") or "",
            description=meta.get("description"),
            license=meta.get("license"),
            stars=meta.get("stars") or 0,
            keywords=meta.get("keywords") or [],
            homepage=meta.get("homepage"),
            repo_url=source.get("repoUrl") or source.get("gitUrl"),
            created_at=meta.get("createdAt"),
            updated_at=meta.get("updatedAt"),
        )
        versions_file = pkg_dir / "versions.json"
        if versions_file.exists():
            versions = _read_json(versions_file).get("data") or []
            pkg.n_versions = len(versions)
            chosen = pick_version(versions, version_strategy)
            if chosen:
                pkg.version = chosen.get("version")
                pkg.revision = chosen.get("revision")
                pkg.version_date = chosen.get("date")
                pkg.toolchain = chosen.get("toolchain")
                pkg.deps = chosen.get("dependencies") or []
        packages.append(pkg)
    return packages


# --------------------------------------------------------------------------- resolve


class Resolver:
    """Maps a lakefile dependency back to the Reservoir package it refers to."""

    def __init__(self, packages: list[Package], index_dir: Path):
        self.by_url: dict[str, str] = {}
        self.by_full: dict[str, str] = {}
        self.by_name: dict[str, set[str]] = defaultdict(set)

        for pkg_dir in sorted(iter_package_dirs(index_dir)):
            meta = _read_json(pkg_dir / "metadata.json")
            full = meta.get("fullName") or ""
            for src in meta.get("sources") or []:
                for key in ("gitUrl", "repoUrl"):
                    norm = normalize_git_url(src.get(key))
                    if norm:
                        self.by_url.setdefault(norm, full)
        for pkg in packages:
            self.by_full[pkg.full_name.lower()] = pkg.full_name
            self.by_name[pkg.name.lower()].add(pkg.full_name)

    def resolve(self, dep: dict[str, Any]) -> tuple[str | None, str]:
        norm = normalize_git_url(dep.get("url"))
        if norm and norm in self.by_url:
            return self.by_url[norm], "url"

        name = (dep.get("name") or "").lower()
        scope = (dep.get("scope") or "").lower()
        if scope and name:
            hit = self.by_full.get(f"{scope}/{name}")
            if hit:
                return hit, "scope+name"
        # A bare name is only trustworthy when exactly one package claims it.
        if name and len(self.by_name.get(name, ())) == 1:
            return next(iter(self.by_name[name])), "name"
        return None, "external"


def external_id(dep: dict[str, Any]) -> str:
    norm = normalize_git_url(dep.get("url"))
    if norm:
        return f"external:{norm}"
    return f"external:?{dep.get('name') or 'unknown'}"


def build_edges(
    packages: list[Package],
    resolver: Resolver,
    include_external: bool,
    include_path_deps: bool,
) -> tuple[list[Edge], Counter]:
    """Build every edge, direct and transitive; callers filter with Edge.transitive."""
    stats: Counter = Counter()
    seen: dict[tuple[str, str], Edge] = {}

    for pkg in packages:
        for dep in pkg.deps:
            dep_type = dep.get("type") or "git"
            transitive = bool(dep.get("transitive"))
            stats["deps_total"] += 1
            if dep_type == "path":
                stats["deps_path_skipped" if not include_path_deps else "deps_path"] += 1
                if not include_path_deps:
                    continue
            stats["deps_transitive" if transitive else "deps_direct"] += 1

            target, how = resolver.resolve(dep)
            # Resolution stats describe the lakefile requires; transitive deps repeat them.
            if not transitive:
                stats[f"resolved_{how}"] += 1
            if target is None:
                if not include_external:
                    continue
                target = external_id(dep)
            if target == pkg.full_name:
                stats["self_edges_skipped"] += 1
                continue

            edge = Edge(
                source=pkg.full_name,
                target=target,
                dep_name=dep.get("name"),
                dep_scope=dep.get("scope"),
                dep_type=dep_type,
                transitive=transitive,
                input_rev=dep.get("inputRev"),
                rev=dep.get("rev"),
                url=dep.get("url"),
                resolved_by=how,
            )
            key = (edge.source, edge.target)
            prev = seen.get(key)
            # Prefer the direct edge if a pair shows up both directly and transitively.
            if prev is None or (prev.transitive and not edge.transitive):
                seen[key] = edge

    return list(seen.values()), stats


# --------------------------------------------------------------------------- analysis


def find_cycles(edges: list[Edge], limit: int = 20) -> list[list[str]]:
    """Return up to `limit` dependency cycles (usually none, but worth flagging)."""
    adj: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        adj[e.source].append(e.target)

    cycles: list[list[str]] = []
    state: dict[str, int] = {}  # 0 = visiting, 1 = done
    stack: list[str] = []

    def walk(node: str) -> None:
        if len(cycles) >= limit:
            return
        state[node] = 0
        stack.append(node)
        for nxt in adj.get(node, ()):
            if state.get(nxt) == 0:
                cycles.append(stack[stack.index(nxt):] + [nxt])
                if len(cycles) >= limit:
                    break
            elif nxt not in state:
                walk(nxt)
        stack.pop()
        state[node] = 1

    sys.setrecursionlimit(max(10000, sys.getrecursionlimit()))
    for node in list(adj):
        if node not in state:
            walk(node)
    return cycles


def dependents_ranking(nodes: list[dict[str, Any]], edges: list[Edge]) -> list[dict[str, Any]]:
    """Libraries ordered by how many other libraries depend on them."""
    users: dict[str, set[str]] = defaultdict(set)
    direct: dict[str, set[str]] = defaultdict(set)
    for e in edges:
        users[e.target].add(e.source)
        if not e.transitive:
            direct[e.target].add(e.source)

    meta = {n["id"]: n for n in nodes}
    ranked = sorted(
        users.items(),
        key=lambda kv: (-len(kv[1]), -len(direct.get(kv[0], ())), kv[0].lower()),
    )
    return [
        {
            "rank": i,
            "package": pkg.replace("external:", ""),
            "dependents": len(srcs),
            "directDependents": len(direct.get(pkg, ())),
            "stars": meta.get(pkg, {}).get("stars"),
            "onReservoir": not meta.get(pkg, {}).get("external", True),
            "dependentList": sorted(srcs, key=str.lower),
        }
        for i, (pkg, srcs) in enumerate(ranked, start=1)
    ]


# --------------------------------------------------------------------------- output


def build_nodes(packages: list[Package], edges: list[Edge]) -> list[dict[str, Any]]:
    in_deg: Counter = Counter()
    out_deg: Counter = Counter()
    for e in edges:
        in_deg[e.target] += 1
        out_deg[e.source] += 1

    known = {p.full_name for p in packages}
    external = sorted({e.target for e in edges if e.target not in known})

    nodes: list[dict[str, Any]] = []
    for pkg in packages:
        nodes.append(
            {
                "id": pkg.full_name,
                "name": pkg.name,
                "owner": pkg.owner,
                "external": False,
                "description": pkg.description,
                "license": pkg.license,
                "stars": pkg.stars,
                "keywords": pkg.keywords,
                "homepage": pkg.homepage,
                "repoUrl": pkg.repo_url,
                "createdAt": pkg.created_at,
                "updatedAt": pkg.updated_at,
                "version": pkg.version,
                "revision": pkg.revision,
                "versionDate": pkg.version_date,
                "toolchain": pkg.toolchain,
                "nIndexedVersions": pkg.n_versions,
                "nDependencies": out_deg.get(pkg.full_name, 0),
                "nDependents": in_deg.get(pkg.full_name, 0),
            }
        )
    for ext in external:
        nodes.append(
            {
                "id": ext,
                "name": ext.split("/")[-1],
                "owner": None,
                "external": True,
                "repoUrl": "https://" + ext[len("external:"):] if not ext.startswith("external:?") else None,
                "nDependencies": 0,
                "nDependents": in_deg.get(ext, 0),
            }
        )
    return nodes


def write_outputs(
    out_dir: Path,
    packages: list[Package],
    edges: list[Edge],
    all_edges: list[Edge],
    stats: Counter,
) -> dict[str, list[dict[str, Any]]]:
    """Write every artifact. `edges` is the emitted graph, `all_edges` includes transitive."""
    out_dir.mkdir(parents=True, exist_ok=True)
    nodes = build_nodes(packages, edges)

    edge_dicts = [
        {
            "source": e.source,
            "target": e.target,
            "depName": e.dep_name,
            "depScope": e.dep_scope,
            "depType": e.dep_type,
            "transitive": e.transitive,
            "inputRev": e.input_rev,
            "rev": e.rev,
            "url": e.url,
            "resolvedBy": e.resolved_by,
        }
        for e in sorted(edges, key=lambda e: (e.source.lower(), e.target.lower()))
    ]

    (out_dir / "graph.json").write_text(
        json.dumps(
            {
                "source": "https://github.com/leanprover/reservoir-index",
                "stats": dict(sorted(stats.items())),
                "nodes": nodes,
                "edges": edge_dicts,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    with (out_dir / "dependencies.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "source",
                "target",
                "depName",
                "depScope",
                "depType",
                "transitive",
                "inputRev",
                "rev",
                "url",
                "resolvedBy",
            ],
        )
        writer.writeheader()
        writer.writerows(edge_dicts)

    with (out_dir / "packages.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "id",
                "name",
                "owner",
                "stars",
                "license",
                "version",
                "toolchain",
                "nDependencies",
                "nDependents",
                "repoUrl",
            ],
            extrasaction="ignore",
        )
        writer.writeheader()
        writer.writerows(n for n in nodes if not n["external"])

    # Both rankings are written on every run, whatever --include-transitive is set to:
    # "direct" counts lakefile requires, "transitive" counts everything a build pulls in.
    all_nodes = build_nodes(packages, all_edges)
    rankings = {
        "direct": dependents_ranking(all_nodes, [e for e in all_edges if not e.transitive]),
        "transitive": dependents_ranking(all_nodes, all_edges),
    }
    for kind, ranking in rankings.items():
        filename = "dependents.csv" if kind == "direct" else "dependents_transitive.csv"
        with (out_dir / filename).open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(
                fh,
                fieldnames=[
                    "rank",
                    "package",
                    "dependents",
                    "directDependents",
                    "stars",
                    "onReservoir",
                    "dependentList",
                ],
            )
            writer.writeheader()
            for row in ranking:
                writer.writerow({**row, "dependentList": ";".join(row["dependentList"])})

    with (out_dir / "graph.dot").open("w", encoding="utf-8") as fh:
        fh.write("digraph reservoir {\n")
        fh.write('  graph [rankdir=LR, overlap=false, splines=true];\n')
        fh.write('  node [shape=box, style=rounded, fontname="Helvetica", fontsize=10];\n')
        for node in nodes:
            attrs = f'label="{node["id"].replace("external:", "")}"'
            if node["external"]:
                attrs += ', style="rounded,dashed", color=gray, fontcolor=gray'
            fh.write(f'  "{node["id"]}" [{attrs}];\n')
        for e in edge_dicts:
            style = ' [style=dotted]' if e["transitive"] else ""
            fh.write(f'  "{e["source"]}" -> "{e["target"]}"{style};\n')
        fh.write("}\n")

    write_report(out_dir / "most-used-libraries.md", packages, all_edges, rankings, stats)
    return rankings


def write_report(
    path: Path,
    packages: list[Package],
    all_edges: list[Edge],
    rankings: dict[str, list[dict[str, Any]]],
    stats: Counter,
) -> None:
    """A human-readable ranking of libraries by how many libraries use them."""
    direct, transitive = rankings["direct"], rankings["transitive"]
    n_direct_edges = sum(1 for e in all_edges if not e.transitive)
    used_directly = {e.target for e in all_edges if not e.transitive}
    unused = [p for p in packages if p.full_name not in used_directly]
    once = sum(1 for r in direct if r["dependents"] == 1)

    def table(rows: list[dict[str, Any]], count_key: str) -> list[str]:
        out = ["| rank | library | used by | stars |", "| ---: | --- | ---: | ---: |"]
        for r in rows:
            name = r["package"] if r["onReservoir"] else f"{r['package']} *(not on Reservoir)*"
            stars = "" if r["stars"] is None else r["stars"]
            out.append(f"| {r['rank']} | `{name}` | {r[count_key]} | {stars} |")
        return out

    lines = [
        "# Most used libraries on Reservoir",
        "",
        "Generated by `reservoir_deps.py` from the",
        "[Reservoir index](https://github.com/leanprover/reservoir-index); each package's",
        "newest indexed version supplies its dependency list. Regenerate with:",
        "",
        "```bash",
        "python3 reservoir_deps.py",
        "```",
        "",
        "## The index at a glance",
        "",
        f"- {len(packages)} packages indexed",
        f"- {stats['deps_direct']} direct dependency records ({n_direct_edges} distinct edges), "
        f"{stats['deps_transitive']} transitive",
        f"- {len(direct)} libraries are required by at least one other package; {once} of them "
        f"by exactly one",
        f"- {len(unused)} packages are never required by anything else",
        "",
        "## 1. By direct dependents",
        "",
        "How many packages name the library in their own lakefile — what authors actually",
        "reach for.",
        "",
        *table(direct, "dependents"),
        "",
        "## 2. Including transitive dependents",
        "",
        "How many packages end up with the library in their build, whether they asked for it",
        "or not. Mathlib's own dependencies overtake mathlib here, because everything that",
        "requires mathlib drags them along.",
        "",
        *table(transitive, "dependents"),
        "",
        "## Caveats",
        "",
        "- Dependencies are matched to indexed packages by repo URL first, then scope+name,",
        "  then a bare name only when exactly one package claims it. Per-edge provenance is in",
        "  `dependencies.csv` (`resolvedBy`).",
        "- Requires pointing at repos Reservoir does not index (e.g. `std`) are excluded unless",
        "  the script is run with `--include-external`; so are in-repo `path` dependencies.",
        "- A package is counted once per library it uses, no matter how many times it appears.",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def print_summary(
    packages: list[Package],
    edges: list[Edge],
    stats: Counter,
    out_dir: Path,
    rankings: dict[str, list[dict[str, Any]]],
    top: int,
) -> None:
    dependents = rankings["direct"]
    out_deg: Counter = Counter(e.source for e in edges)
    no_versions = [p for p in packages if p.n_versions == 0]
    leaves = [p for p in packages if out_deg.get(p.full_name, 0) == 0]

    print()
    print(f"packages in the Reservoir index : {len(packages)}")
    print(f"  with no indexed version       : {len(no_versions)}")
    print(f"  with no dependencies          : {len(leaves)}")
    print(f"dependency records read         : {stats['deps_total']}")
    print(f"  direct (from the lakefile)    : {stats['deps_direct']}")
    print(f"  transitive                    : {stats['deps_transitive']}")
    print(f"  local path deps (skipped)     : {stats['deps_path_skipped']}")
    print(f"edges written                   : {len(edges)}")
    print(f"  matched by repo URL           : {stats['resolved_url']}")
    print(f"  matched by scope+name         : {stats['resolved_scope+name']}")
    print(f"  matched by unique name        : {stats['resolved_name']}")
    print(f"  unmatched (not on Reservoir)  : {stats['resolved_external']}")

    for kind, label in (("direct", "direct dependents"), ("transitive", "incl. transitive")):
        ranking = rankings[kind]
        shown = ranking if top <= 0 else ranking[:top]
        print(f"\nmost used libraries by {label} ({len(shown)} of {len(ranking)}):")
        print(f"  {'rank':>4}  {'used by':>7}  package")
        for row in shown:
            tag = "" if row["onReservoir"] else "  (not on Reservoir)"
            print(f"  {row['rank']:>4}  {row['dependents']:>7}  {row['package']}{tag}")

    print("\npackages with the most direct dependencies:")
    for name, count in out_deg.most_common(10):
        print(f"  {count:5d}  {name}")

    cycles = find_cycles(edges)
    if cycles:
        print(f"\ndependency cycles found ({len(cycles)} shown):")
        for cycle in cycles:
            print("  " + " -> ".join(cycle))

    print(
        f"\nwrote {out_dir}/most-used-libraries.md, graph.json, dependencies.csv, "
        "packages.csv, dependents.csv, dependents_transitive.csv, graph.dot"
    )
    print("render with:  dot -Tsvg %s/graph.dot -o reservoir.svg" % out_dir)


# --------------------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a dependency graph of all packages on Reservoir.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--index-dir",
        type=Path,
        help="use an existing checkout of leanprover/reservoir-index instead of downloading",
    )
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE, help="where to cache the index")
    parser.add_argument("--refresh", action="store_true", help="re-download the index even if cached")
    parser.add_argument("--out-dir", type=Path, default=Path("output"), help="directory for generated files")
    parser.add_argument(
        "--version-strategy",
        choices=["latest", "oldest"],
        default="latest",
        help="which indexed version of each package to read dependencies from",
    )
    parser.add_argument(
        "--include-transitive",
        action="store_true",
        help="also emit edges for dependencies pulled in indirectly, not just lakefile requires",
    )
    parser.add_argument(
        "--include-external",
        action="store_true",
        help="keep dependencies on repositories that are not indexed by Reservoir",
    )
    parser.add_argument(
        "--include-path-deps",
        action="store_true",
        help="keep `require ... from` local path dependencies (in-repo subpackages)",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=25,
        help="how many entries of the most-used-library ranking to print (0 for all)",
    )
    parser.add_argument("--quiet", action="store_true", help="skip the summary report")
    args = parser.parse_args(argv)

    index_dir = args.index_dir.expanduser() if args.index_dir else fetch_index(args.cache_dir, args.refresh)
    if not index_dir.is_dir():
        parser.error(f"index directory not found: {index_dir}")

    packages = load_packages(index_dir, args.version_strategy)
    if not packages:
        parser.error(f"no packages found under {index_dir}")
    resolver = Resolver(packages, index_dir)
    all_edges, stats = build_edges(
        packages,
        resolver,
        include_external=args.include_external,
        include_path_deps=args.include_path_deps,
    )
    edges = all_edges if args.include_transitive else [e for e in all_edges if not e.transitive]
    rankings = write_outputs(args.out_dir, packages, edges, all_edges, stats)
    if not args.quiet:
        print_summary(packages, edges, stats, args.out_dir, rankings, args.top)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
