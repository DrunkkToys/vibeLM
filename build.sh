#!/bin/bash
set -euo pipefail

SOURCE_DIR="/Users/drunkktoys/Desktop/vibeLM"
INSTALL_DIR="/Users/drunkktoys/.lmstudio/extensions/plugins/drunkktoys/vibe-lm"
LEGACY_INSTALL_DIR_1="/Users/drunkktoys/.lmstudio/extensions/plugins/drunkktoys/agentic-tools"
LEGACY_INSTALL_DIR_2="/Users/drunkktoys/.lmstudio/extensions/plugins/drunkktoys/vibeLM"

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
(rm -rf "$LEGACY_INSTALL_DIR_1" "$LEGACY_INSTALL_DIR_2")
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

# 6. Preserve runtime config.json when it already exists.
echo "▸ Preserving config.json..."
if [ ! -f "$INSTALL_DIR/config.json" ]; then
  cp "$SOURCE_DIR/config.json" "$INSTALL_DIR/config.json"
  echo "  ✓ config.json initialized"
else
  echo "  ✓ config.json preserved"
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
