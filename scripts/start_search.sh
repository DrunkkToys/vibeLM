#!/bin/bash
# Start the search proxy server for vibeLM web_search.
# Run this BEFORE starting LM Studio.
# Endpoint: http://localhost:8394/search?q=...&format=json

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8394

# Kill existing proxy if running
if lsof -ti:$PORT >/dev/null 2>&1; then
  echo "Stopping existing search proxy on port $PORT..."
  kill $(lsof -ti:$PORT) 2>/dev/null
  sleep 1
fi

echo "Starting search proxy on port $PORT..."
python3 "$SCRIPT_DIR/search_server.py" &
PROXY_PID=$!

sleep 1

if kill -0 $PROXY_PID 2>/dev/null; then
  echo "✓ Search proxy running (PID $PROXY_PID)"
  echo ""
  echo "Set this env var before starting LM Studio:"
  echo "  export AGENTIC_SEARCH_ENDPOINT=http://localhost:$PORT/search"
  echo ""
  echo "Or add to your shell profile (~/.zshrc):"
  echo "  export AGENTIC_SEARCH_ENDPOINT=http://localhost:$PORT/search"
else
  echo "✗ Search proxy failed to start"
  exit 1
fi
