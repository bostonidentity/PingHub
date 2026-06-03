#!/usr/bin/env bash
# PingHub release: stop the running server.
set -euo pipefail
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pinghub"
PID_FILE="$LOG_DIR/pinghub.pid"
LOG="[PingHub]"

if [ ! -f "$PID_FILE" ]; then
  echo "$LOG not running (no PID file)"
  exit 0
fi
PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "$LOG stale PID file (PID $PID not running); cleaning up"
  rm -f "$PID_FILE"
  exit 0
fi
echo "$LOG stopping PID $PID..."
kill "$PID" 2>/dev/null || true
sleep 1
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "$LOG stopped"
