# Reservoir package discovery misses 279 eligible repositories

Found while joining [Palomar](https://palomar-registry.org) entries onto Reservoir packages:
a registered repo with 27 stars and an Apache-2.0 licence, `AxiomMath/PrimeGapsLib`, was not
in the index and never would be.

## The bug

Reservoir discovers packages with a single GitHub code search and reads only the first ~900
results of it. `scripts/utils/repo.py`:

```python
def query_lake_repos(limit: int) -> list[str]:
  rate_limit = query_github_api("rate_limit")['resources']['code_search']
  if limit < 0:
    # NOTE: GitHub limits code searches to 10 requests/min, which is 1000 results.
    # Thus, the strategy used here will need to change when we hit that limit.
    limit = (rate_limit['limit']-1)*100        # 900
  query='filename:lake-manifest.json path:/'
  items = query_github_results(limit, "search/code", {"q": query})
```

That query now matches **5,904** repositories. `query_github_results` always starts at
`page = 1` with no sort qualifier and no persisted cursor, so every run reads the same
prefix. Repos outside it are not delayed or queued, they are unreachable. The NOTE in the
source anticipated this exactly, and the threshold has now been crossed.

The daily workflow passes `-Q -1` (`.github/workflows/testbed.yml:157`), so production runs
with the 900 cap.

## Scale

| | |
|---|---|
| Repos matching the discovery query | 5,904 |
| Enumerated by partitioning the query on file size | 5,763 |
| Reachable by the crawler in one run | 900 |
| Enumerated but not in the index | 5,035 |
| **Of those, pass Reservoir's own `curate_repos`** | **279** |
| Currently in the index | 808 |

The index is missing roughly 26% of the packages it should hold. Of the 279: minimum 2 stars
(the gate itself), median 4, maximum 333, and **68 have 10 or more stars**. Examples:
`lambdaclass/concrete` (333), `google-deepmind/alphaproof-nexus-results` (287),
`avigad/mathematics_in_lean_source` (211), `anthropics/zeta-23-lean` (169),
`kim-em/lean-zip` (114), `AxiomMath/PrimeGapsLib` (27).

279 is a **floor**, not a census. The `size:0..390` slice returned 958 results, close enough
to the 1,000 cap that its tail is probably clipped, which is why 5,763 of 5,904 were
enumerated.

## Reproducing

Run Reservoir's own discovery against a current index clone, with the argument the daily
workflow uses:

```bash
cd /path/to/leanprover/reservoir
python3 -m venv venv && venv/bin/pip install requests
GH_TOKEN=$(gh auth token) venv/bin/python -c "
import sys; sys.path.insert(0, 'scripts')
from utils.repo import query_new_repos
from utils.index import load_index_metadata, github_repo_id
pkgs = load_index_metadata('/path/to/reservoir-index')
new = query_new_repos(-1, set(filter(None, map(github_repo_id, pkgs))), set())
print(sorted(r['nameWithOwner'] for r in new))
"
```

Output:

```
INFO Searching for new Lean/Lake repositories
INFO 900 candidate repositories with root Lake manifests
INFO 712 candidate repositories not in index
INFO 6 notable new OSI-licensed repositories
```

900 candidates against a population of 5,904, and `AxiomMath/PrimeGapsLib` is not among
them. Confirm the population size independently:

```bash
gh api -X GET search/code -f q='filename:lake-manifest.json path:/' -F per_page=1 --jq .total_count
# 5904
```

## The fix

Partition the query so every slice returns fewer than 1,000 results, then union the slices.
Partitioning on the manifest's file size works and is verified:

```bash
gh api -X GET search/code -f q='filename:lake-manifest.json path:/ size:4111..4191' \
  -F per_page=100 --jq '.items[].repository.full_name' | grep -n PrimeGapsLib
# 3:AxiomMath/PrimeGapsLib
```

That slice holds 17 results instead of 5,904, and the previously invisible repo is third.
Splitting recursively whenever a slice reports 1,000 or more covered the whole corpus in 27
slices. The cost is more search requests, which is bounded by the 10 per minute code search
limit, so a full sweep is a few minutes rather than one request.

**`sort=indexed` does not work.** It looks like the obvious fix, but GitHub ignores `sort`
and `order` on code search now and returns the same established repos, so recency ordering
is not available as a shortcut.

## Separately: the workflow fails about half the time

Not the cause of the above, but it compounds it. The last ten `Scheduled Update` runs:

```
08-18 success   08-17 failure   08-16 failure   08-15 failure   08-14 success
08-13 success   08-12 failure   08-11 success   08-10 cancelled 08-09 failure
```

Failures land on `Testbed / Setup`, the job carrying `search-packages: true`, so a failed run
discovers nothing at all. This is why `teorth/sendov` (27 stars, inside the reachable 900,
and returned by the repro above) is still absent: the three runs after it appeared all failed.
Even at a 100% success rate the 279 would remain missing.
