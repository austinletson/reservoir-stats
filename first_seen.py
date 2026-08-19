#!/usr/bin/env python3
"""Work out when each package first appeared in the Reservoir index.

`reservoir_stats.py` needs a `firstMonth` per package: the month the package entered
the registry. Neither of the obvious sources gives it.

- `metadata.json`'s `createdAt` is when the *repository* was created on GitHub, which
  for e.g. mathlib is 2021 — years before Reservoir existed.
- The oldest entry in `versions.json` is when the oldest *retained* version was built.
  558 of ~805 packages retain exactly one version entry, so for most of the registry
  that date is a recent rebuild. Using it would invent a growth spike in whatever month
  the last build sweep ran.

The real answer is in the index's own git history: the commit that first added
`<owner>/<name>/metadata.json`. This script walks that history once and writes the
result to `data/first-seen.json`, which is committed and read by the daily build.

Keying is by **repo URL, not index path**, because packages get renamed — `mathlib4` ->
`mathlib`, `proofwidgets4` -> `proofwidgets`, `importgraph` -> `import-graph`, and 100+
others. Keying by path would make every renamed package look brand new on the day it
was renamed.

Usage:
    python3 first_seen.py                        # clone the index, write data/first-seen.json
    python3 first_seen.py --repo ~/src/reservoir-index   # use an existing full clone
    python3 first_seen.py --out data/first-seen.json

The clone is a full one (~640MB, ~80s) because the history walk needs the blobs; a
`--filter=blob:none` clone refetches them one at a time and is far slower overall.
That is why this is a separate, occasional script rather than part of the daily build.

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from reservoir_deps import identity_keys

INDEX_REPO = "https://github.com/leanprover/reservoir-index.git"


def run(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(
        args, cwd=cwd, check=True, capture_output=True, text=True, errors="replace"
    )
    return proc.stdout


def clone_index(dest: Path) -> Path:
    print(f"cloning {INDEX_REPO} -> {dest} (this takes a minute)", file=sys.stderr)
    subprocess.run(
        ["git", "clone", "--quiet", INDEX_REPO, str(dest)],
        check=True,
    )
    return dest


def additions(repo: Path) -> list[tuple[str, str, str]]:
    """Every commit that added a metadata.json, as (commit, date, path), oldest first."""
    out = run(
        [
            "git",
            "log",
            "--reverse",
            "--diff-filter=A",
            "--name-only",
            "--format=C|%H|%ad",
            "--date=short",
            "--",
            "*/metadata.json",
        ],
        repo,
    )
    rows: list[tuple[str, str, str]] = []
    commit = date = ""
    for line in out.splitlines():
        if line.startswith("C|"):
            _, commit, date = line.split("|", 2)
        elif line.endswith("/metadata.json"):
            rows.append((commit, date, line))
    return rows


def read_blobs(repo: Path, refs: list[str]) -> dict[str, str]:
    """Batch-read `<commit>:<path>` blobs. One git process, not one per file."""
    if not refs:
        return {}
    proc = subprocess.run(
        ["git", "cat-file", "--batch"],
        cwd=repo,
        input=("\n".join(refs) + "\n").encode(),
        check=True,
        capture_output=True,
    )
    out = proc.stdout
    blobs: dict[str, str] = {}
    pos = 0
    for ref in refs:
        nl = out.find(b"\n", pos)
        if nl < 0:
            break
        header = out[pos:nl].decode("utf-8", "replace")
        parts = header.split()
        if len(parts) != 3:  # "<oid> missing" — path absent at that commit
            pos = nl + 1
            continue
        size = int(parts[2])
        blobs[ref] = out[nl + 1 : nl + 1 + size].decode("utf-8", "replace")
        pos = nl + 1 + size + 1  # trailing newline after the payload
    return blobs


def keys_of(blob: str) -> tuple[str | None, str | None]:
    """(GitHub node id, normalised repo URL) for one metadata.json blob.

    Delegates to `reservoir_deps.identity_keys` so the tables written here and the lookups
    in `reservoir_stats.py` cannot drift apart. See that docstring for why each key space
    exists and what happened when the two sides extracted them separately.
    """
    try:
        meta = json.loads(blob)
    except json.JSONDecodeError:
        return None, None
    node_id, url, _raw, _full = identity_keys(meta)
    return node_id, url


def build(repo: Path) -> dict[str, object]:
    rows = additions(repo)
    print(f"{len(rows)} metadata.json additions in history", file=sys.stderr)

    blobs = read_blobs(repo, [f"{commit}:{path}" for commit, _, path in rows])

    by_id: dict[str, str] = {}
    by_url: dict[str, str] = {}
    by_path: dict[str, str] = {}
    name_paths: dict[str, set[str]] = {}
    by_name: dict[str, str] = {}
    no_url = 0

    def earliest(table: dict[str, str], key: str, date: str) -> None:
        # `min`, not first-write: a package can be removed and re-added later, and the
        # history is walked oldest-first but a re-add would otherwise overwrite.
        if key not in table or date < table[key]:
            table[key] = date

    for commit, date, path in rows:
        pkg = "/".join(path.split("/")[:2])
        earliest(by_path, pkg, date)
        name = pkg.split("/")[-1].lower()
        name_paths.setdefault(name, set()).add(pkg)
        earliest(by_name, name, date)

        node_id, url = keys_of(blobs.get(f"{commit}:{path}", ""))
        if node_id:
            earliest(by_id, node_id, date)
        if url:
            earliest(by_url, url, date)
        else:
            no_url += 1

    # A bare package name is only usable as a key when exactly one repo ever claimed it.
    # 16 names in the registry are claimed by two owners, and guessing on those would
    # silently backdate a new package to an unrelated older one.
    ambiguous = {n for n, paths in name_paths.items() if len(paths) > 1}
    by_name = {n: d for n, d in by_name.items() if n not in ambiguous}

    print(
        f"{len(by_id)} node ids, {len(by_url)} repo URLs, {len(by_path)} index paths, "
        f"{len(by_name)} unambiguous names ({len(ambiguous)} names dropped as ambiguous), "
        f"{no_url} additions with no readable repo URL",
        file=sys.stderr,
    )
    return {
        "source": INDEX_REPO,
        "indexHead": run(["git", "rev-parse", "HEAD"], repo).strip(),
        "indexHeadDate": run(["git", "log", "-1", "--format=%ad", "--date=short"], repo).strip(),
        "indexStart": min(by_path.values()),
        "note": (
            "First date each package's metadata.json appeared in the Reservoir index. "
            "Look up in order: byNodeId (GitHub repo id, survives org renames), byRepo "
            "(normalised URL, survives index renames), byPath (<owner>/<name> as spelled "
            "at the time), byName (bare name, only where unambiguous)."
        ),
        "byNodeId": dict(sorted(by_id.items())),
        "byRepo": dict(sorted(by_url.items())),
        "byPath": dict(sorted(by_path.items())),
        "byName": dict(sorted(by_name.items())),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Record when each package first appeared in the Reservoir index.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--repo", type=Path, help="an existing full clone of leanprover/reservoir-index"
    )
    parser.add_argument(
        "--out", type=Path, default=Path("data/first-seen.json"), help="where to write"
    )
    args = parser.parse_args(argv)

    tmp: str | None = None
    try:
        if args.repo:
            repo = args.repo.expanduser()
            if not (repo / ".git").is_dir():
                parser.error(f"not a git clone: {repo}")
        else:
            tmp = tempfile.mkdtemp(prefix="reservoir-index-")
            repo = clone_index(Path(tmp) / "reservoir-index")
        data = build(repo)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
