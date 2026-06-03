#!/usr/bin/env bash
# PingHub release launcher (macOS/Linux).
# Self-contained: uses bundled Node if present, otherwise system Node 20+.

set -euo pipefail

DIST_ROOT="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$DIST_ROOT/launcher/launcher.mjs"
BUNDLED_NODE="$DIST_ROOT/node/bin/node"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pinghub"
PID_FILE="$LOG_DIR/pinghub.pid"
OUT_LOG="$LOG_DIR/pinghub.out.log"
ERR_LOG="$LOG_DIR/pinghub.err.log"
LOG="[PingHub]"

if [ ! -f "$LAUNCHER" ]; then
  echo "$LOG ERROR: missing $LAUNCHER" >&2
  exit 1
fi

# Already running?
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "$LOG PingHub is already running (PID $PID). Run ./stop.sh first."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# Pick Node.
NODE_EXE=""
if [ -x "$BUNDLED_NODE" ]; then
  NODE_EXE="$BUNDLED_NODE"
  echo "$LOG using bundled Node $("$NODE_EXE" -v)"
elif command -v node >/dev/null 2>&1; then
  NV="$(node -v | sed 's/^v//')"
  NMAJ="${NV%%.*}"
  if [ "$NMAJ" -ge 20 ]; then
    NODE_EXE="$(command -v node)"
    echo "$LOG using system Node v$NV"
  fi
fi
if [ -z "$NODE_EXE" ]; then
  echo "$LOG ERROR: Node 20+ not found. Install from https://nodejs.org or use the bundled-node release." >&2
  exit 2
fi

mkdir -p "$LOG_DIR"
echo "$LOG launching in background..."
nohup "$NODE_EXE" "$LAUNCHER" "$@" >"$OUT_LOG" 2>"$ERR_LOG" &
PID=$!
echo "$PID" > "$PID_FILE"

sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  echo "$LOG ERROR: PingHub failed to start. Recent log:" >&2
  echo "----------------------------------------------------------------" >&2
  [ -f "$ERR_LOG" ] && tail -n 50 "$ERR_LOG" >&2
  [ -f "$OUT_LOG" ] && tail -n 50 "$OUT_LOG" >&2
  echo "----------------------------------------------------------------" >&2
  rm -f "$PID_FILE"
  exit 5
fi

echo "$LOG started successfully (PID $PID)"
echo "$LOG   log:  $OUT_LOG"
echo "$LOG   stop: ./stop.sh"
