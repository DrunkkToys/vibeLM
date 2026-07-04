#!/bin/bash
set -euo pipefail

# ─── Single build command ────────────────────────────────────────────────────
# Source:  ~/Desktop/vibeLM/
# Target:  ~/.lmstudio/extensions/plugins/drunkktoys/agentic-tools
# Uses lms dev --install (LM Studio's own installer) to bundle production.js.
# No esbuild, no manual production.js — LM Studio handles it correctly.

SOURCE_DIR="/Users/drunkktoys/Desktop/vibeLM"
INSTALL_DIR="/Users/drunkktoys/.lmstudio/extensions/plugins/drunkktoys/agentic-tools"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Building agentic-tools plugin"
echo "  Source:  $SOURCE_DIR"
echo "  Target:  $INSTALL_DIR"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Step 1: Compile TypeScript ───────────────────────────────────────────────
echo "▸ Compiling TypeScript (src/ → dist/)..."
(cd "$SOURCE_DIR" && ./node_modules/.bin/tsc)
echo "  ✓ tsc complete"

# ── Step 2: Install via LM Studio's own installer ─────────────────────────────
# lms dev --install bundles entry.ts + dist/ into production.js
# and places it in the LM Studio extensions directory.
echo "▸ Installing plugin via lms dev --install..."
(cd "$SOURCE_DIR" && lms dev --install --yes)
echo "  ✓ Plugin installed"

# ── Step 3: Verify ────────────────────────────────────────────────────────────
echo ""
echo "▸ Verifying installed plugin..."

FAIL=0

check_file() {
  local path="$1"
  local label="$2"
  if [ -f "$path" ]; then
    local size
    size=$(stat -f%z "$path" 2>/dev/null)
    echo "  ✓ $label  (${size} bytes)"
  else
    echo "  ✗ MISSING: $label"
    FAIL=1
  fi
}

check_string() {
  local path="$1"
  local str="$2"
  local label="$3"
  if grep -q "$str" "$path" 2>/dev/null; then
    echo "  ✓ marker: $label"
  else
    echo "  ✗ MISSING: $label"
    FAIL=1
  fi
}

echo ""
echo "  ── Files ──"
check_file "$INSTALL_DIR/.lmstudio/production.js"   "production.js"

echo ""
echo "  ── Fix markers ──"
check_string "$INSTALL_DIR/.lmstudio/production.js"  "initCompleted"     "initCompleted"
check_string "$INSTALL_DIR/.lmstudio/production.js"  "withToolsProvider" "withToolsProvider"
check_string "$INSTALL_DIR/.lmstudio/production.js"  "\[ENTRY\]"         "[ENTRY] loaded"

echo ""
if [ "$FAIL" = "1" ]; then
  echo "✗ VERIFICATION FAILED"
  exit 1
else
  echo "✓ VERIFICATION PASSED"
fi
echo ""
echo "───────────────────────────────────────────────────────────"
echo "  Build complete."
echo "───────────────────────────────────────────────────────────"

# ── Step 4: Start search proxy ──────────────────────────────────────────────
SEARCH_PORT=8394
if lsof -ti:$SEARCH_PORT >/dev/null 2>&1; then
  echo "▸ Search proxy already running on port $SEARCH_PORT"
else
  echo "▸ Starting search proxy on port $SEARCH_PORT..."
  python3 "$SOURCE_DIR/scripts/search_server.py" &
  sleep 1
  if lsof -ti:$SEARCH_PORT >/dev/null 2>&1; then
    echo "  ✓ Search proxy running"
  else
    echo "  ✗ Search proxy failed to start"
  fi
fi
export AGENTIC_SEARCH_ENDPOINT="http://localhost:$SEARCH_PORT/search"
echo ""
echo "  Search endpoint: $AGENTIC_SEARCH_ENDPOINT"
