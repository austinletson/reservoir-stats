# Build the site's data, then serve it at http://127.0.0.1:8765
run: build
    python3 serve.py

# Reading formalization.yaml from 808 repositories needs an authenticated GitHub budget on
# a cold run, so pass a token through: `GITHUB_TOKEN=$(gh auth token) just build`. Without
# one the builder warns and skips that data rather than half-collecting it. Warm runs only
# ask about repositories the index says were pushed to, so they need no requests at all.

# Build site/data/summary.json
build:
    python3 reservoir_stats.py

# Serve site/ without rebuilding the data
serve:
    python3 serve.py

# Install PyYAML, the one dependency, for reading formalization.yaml
deps:
    python3 -m pip install -r requirements.txt

# Re-download the Reservoir index, then rebuild
refresh:
    python3 reservoir_stats.py --refresh
