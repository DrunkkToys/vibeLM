#!/bin/bash
set -euo pipefail

SOURCE_DIR="/Users/drunkktoys/Desktop/vibeLM"
INSTALL_DIR="/Users/drunkktoys/.lmstudio/extensions/plugins/drunkktoys/vibe-lm"
# Persistent runtime data (config.json, runtime-state.json, session-log.jsonl) lives here, NOT in
# INSTALL_DIR, because `lms dev --install` wipes INSTALL_DIR on every deploy. Must match DATA_DIR
# in src/toolsProvider.ts.
DATA_DIR="/Users/drunkktoys/.lmstudio/extensions/data/drunkktoys/vibe-lm"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Building vibeLM plugin"
echo "═══════════════════════════════════════════════════════"
echo ""

# 1. Compile TypeScript
echo "▸ Compiling TypeScript..."
(cd "$SOURCE_DIR" && ./node_modules/.bin/tsc)
echo "  ✓ tsc complete"

# 2. Temporarily remove .opencode/.gitignore (lms dev rejects nested gitignores)
GITIGNORE_BAK=""
if [ -f "$SOURCE_DIR/.opencode/.gitignore" ]; then
  GITIGNORE_BAK="$SOURCE_DIR/.opencode/.gitignore.bak"
  mv "$SOURCE_DIR/.opencode/.gitignore" "$GITIGNORE_BAK"
  echo "  ✓ Temporarily removed .opencode/.gitignore"
fi

# 3. Install via LM Studio
echo "▸ Installing plugin..."
(cd "$SOURCE_DIR" && lms dev --install --yes)
echo "  ✓ Plugin installed"

# 4. Restore .opencode/.gitignore
if [ -n "$GITIGNORE_BAK" ] && [ -f "$GITIGNORE_BAK" ]; then
  mv "$GITIGNORE_BAK" "$SOURCE_DIR/.opencode/.gitignore"
  echo "  ✓ Restored .opencode/.gitignore"
fi

# 5. Copy dist/ (lms dev --install deletes it)
echo "▸ Copying dist/ to install dir..."
cp -r "$SOURCE_DIR/dist" "$INSTALL_DIR/dist"
echo "  ✓ dist/ copied"

# 5b. Drop devDependencies from the install.
# `lms dev --install` copies node_modules wholesale, so the test toolchain (Playwright,
# TypeScript, tsx, esbuild) ships to every user — ~18MB of Playwright alone. production.js
# requires only @lmstudio/sdk, mathjs, ws and zod at runtime, so anything outside the
# production dependency closure is dead weight.
#
# Fail-safe: if the closure cannot be computed, nothing is deleted and the build continues.
echo "▸ Pruning devDependencies from install..."
KEEP_LIST="$(cd "$SOURCE_DIR" && npm ls --omit=dev --all --parseable 2>/dev/null \
  | sed "s|.*/node_modules/||" \
  | grep -v "^/" \
  | awk -F/ '{if (substr($1,1,1)=="@") print $1"/"$2; else print $1}' \
  | sort -u)" || true

if [ -z "$KEEP_LIST" ] || [ ! -d "$INSTALL_DIR/node_modules" ]; then
  echo "  ⚠ skipped (no production closure or no node_modules) — nothing deleted"
else
  BEFORE_KB=$(du -sk "$INSTALL_DIR/node_modules" | cut -f1)
  DROPPED=0

  # Collect installed top-level packages, expanding @scope/ dirs one level.
  # npm hoists transitive deps to top level, so this covers the whole tree.
  INSTALLED_PKGS=()
  for entry in "$INSTALL_DIR"/node_modules/*/; do
    [ -d "$entry" ] || continue
    name=$(basename "${entry%/}")
    if [ "${name#@}" != "$name" ]; then
      for sub in "$entry"*/; do
        [ -d "$sub" ] || continue
        INSTALLED_PKGS+=("$name/$(basename "${sub%/}")")
      done
    else
      INSTALLED_PKGS+=("$name")
    fi
  done

  for pkg in ${INSTALLED_PKGS+"${INSTALLED_PKGS[@]}"}; do
    if ! printf '%s\n' "$KEEP_LIST" | grep -qxF "$pkg"; then
      rm -rf "${INSTALL_DIR:?}/node_modules/${pkg:?}"
      DROPPED=$((DROPPED + 1))
    fi
  done
  # Empty scope dirs and .bin entries pointing at removed packages are now dangling.
  find "$INSTALL_DIR/node_modules" -maxdepth 1 -type d -name '@*' -empty -delete 2>/dev/null || true
  find "$INSTALL_DIR/node_modules/.bin" -maxdepth 1 -type l ! -exec test -e {} \; -delete 2>/dev/null || true
  AFTER_KB=$(du -sk "$INSTALL_DIR/node_modules" | cut -f1)
  echo "  ✓ removed $DROPPED dev package(s): $((BEFORE_KB / 1024))MB → $((AFTER_KB / 1024))MB"
fi

# 6. Seed runtime config.json in DATA_DIR (outside INSTALL_DIR, so reinstalls never touch it).
echo "▸ Preserving config.json..."
mkdir -p "$DATA_DIR"
if [ ! -f "$DATA_DIR/config.json" ]; then
  cp "$SOURCE_DIR/config.json" "$DATA_DIR/config.json"
  echo "  ✓ config.json initialized"
else
  echo "  ✓ config.json preserved"
fi

# 6b. Remove legacy enabledTools from the persisted config so LM Studio only shows the toggle-based tool UI.
if [ -f "$DATA_DIR/config.json" ] && command -v node >/dev/null 2>&1; then
  CONFIG_PATH="$DATA_DIR/config.json" node <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;
try {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8"));
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "enabledTools")) {
    const { enabledTools, ...cleaned } = raw;
    fs.writeFileSync(path, JSON.stringify(cleaned, null, 2) + "\n", "utf-8");
    console.log("  ✓ removed legacy enabledTools from config.json");
  }
} catch (err) {
  console.warn("  ⚠ could not normalize config.json:", err.message);
}
NODE
fi

# 7. Verify
echo "▸ Verifying..."
if [ -f "$INSTALL_DIR/.lmstudio/production.js" ] && [ -f "$INSTALL_DIR/dist/index.js" ]; then
  echo "  ✓ production.js ($(stat -f%z "$INSTALL_DIR/.lmstudio/production.js") bytes)"
  echo "  ✓ dist/index.js ($(stat -f%z "$INSTALL_DIR/dist/index.js") bytes)"
else
  echo "  ✗ MISSING FILES"
  exit 1
fi

# 8. Start search proxy
if ! lsof -ti:8394 >/dev/null 2>&1; then
  echo "▸ Starting search proxy..."
  python3 "$SOURCE_DIR/scripts/search_server.py" &
  sleep 1
fi
echo "  ✓ Search proxy running on port 8394"

echo ""
echo "✓ Build complete"
