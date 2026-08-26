# Build the site's data, then serve it at http://127.0.0.1:8765
run: build
    python3 serve.py

# Build site/data/summary.json
build:
    python3 reservoir_stats.py

# Serve site/ without rebuilding the data
serve:
    python3 serve.py
