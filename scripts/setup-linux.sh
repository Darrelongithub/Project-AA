#!/usr/bin/env bash
# Project-AA — one-shot Linux setup (Ubuntu/Debian).
# Other distros: install the equivalents with your package manager
# (node >= 20, a C/C++ toolchain + python3 for the native modules' fallback
# builds, optionally Chromium for the UI layout probes).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── Project-AA Linux setup ──────────────────────────────────"

# 1. Node.js 20+ (skip if a suitable node is already on PATH)
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -ge 20 ]; then
  echo "node $(node -v) found — ok"
else
  echo "Installing Node.js 20 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 2. Build toolchain — only needed if a native module (better-sqlite3, sharp,
#    canvas) can't use its prebuilt binary and has to compile from source.
sudo apt-get update
sudo apt-get install -y build-essential python3 pkg-config \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

# 3. npm dependencies (lockfile-pinned, no audit noise)
npm ci --no-audit --no-fund

# 4. Optional: Chromium for the UI layout probes (scripts/ui-*.mts, responsive
#    tests). Everything else runs without a browser.
if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  if sudo apt-get install -y chromium 2>/dev/null; then
    echo "chromium installed"
  else
    echo "chromium not available in this distro's repos — UI probes will skip themselves"
  fi
fi

echo
echo "Done. Next:"
echo "  npm run typecheck   # strict TypeScript"
echo "  npm test            # full suite"
echo "  npm run serve       # staff console on http://localhost:3000 (PORT=… to change)"
