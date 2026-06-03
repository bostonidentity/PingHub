#!/usr/bin/env bash
# PingHub release: show server status.
set -euo pipefail
PID_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/pinghub/pinghub.pid"
LOG="[PingHub]"

if [ ! -f "$PID_FILE" ]; then
  echo "$LOG not running"
  exit 1
fi
PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "$LOG not running (stale PID $PID)"
  exit 1
fi
echo "$LOG running (PID $PID)"
