#!/usr/bin/env bash
# PingHub updater (macOS / Linux).
#
# Args:
#   $1 = install dir (the dist root containing app/, launcher/, start.sh, version.json)
#   $2 = path to the downloaded release archive (.tar.gz)
#   $3 = PID of the old server process to wait for
#   $4 = port to relaunch on
#
# This script is copied to a temp dir before execution so the install
# directory can be moved without affecting the running updater.

set -u

INSTALL="${1:-}"
NEWTGZ="${2:-}"
OLDPID="${3:-}"
PORT="${4:-3000}"

if [ -z "$INSTALL" ] || [ -z "$NEWTGZ" ] || [ -z "$OLDPID" ]; then
  echo "[updater] usage: updater.sh <install-dir> <archive> <old-pid> [port]" >&2
  exit 10
fi

LOG="$(mktemp -t pinghub-updater.XXXXXX).log"
{
  echo "[updater] $(date)"
  echo "[updater] install=$INSTALL"
  echo "[updater] archive=$NEWTGZ"
  echo "[updater] oldpid=$OLDPID port=$PORT"
} > "$LOG"

# 1. Wait for the old server to exit (up to ~60s), then force-kill.
echo "[updater] waiting for PID $OLDPID" >> "$LOG"
for _ in $(seq 1 60); do
  if ! kill -0 "$OLDPID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$OLDPID" 2>/dev/null; then
  echo "[updater] PID $OLDPID still running; force-killing" >> "$LOG"
  kill -9 "$OLDPID" 2>/dev/null || true
fi
sleep 2

# 2. Extract new archive to a sibling stage dir.
PARENT="$(dirname "$INSTALL")"
STAGE="$(mktemp -d "$PARENT/.pinghub-stage.XXXXXX")"
echo "[updater] extracting to $STAGE" >> "$LOG"
if ! tar -xzf "$NEWTGZ" -C "$STAGE" >> "$LOG" 2>&1; then
  echo "[updater] ERROR: extract failed" >> "$LOG"
  rm -rf "$STAGE"
  echo "[updater] FAILED — log: $LOG" >&2
  exit 1
fi

# The tar contains exactly one top-level folder.
NEWDIR="$(find "$STAGE" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$NEWDIR" ]; then
  echo "[updater] ERROR: no top-level dir found in stage" >> "$LOG"
  rm -rf "$STAGE"
  exit 2
fi
echo "[updater] new dir: $NEWDIR" >> "$LOG"

# 3. Move old install aside, then move new in place.
BACKUP="${INSTALL}.bak-$(date +%s)"
echo "[updater] $INSTALL -> $BACKUP" >> "$LOG"
if ! mv "$INSTALL" "$BACKUP" >> "$LOG" 2>&1; then
  echo "[updater] ERROR: move-aside failed" >> "$LOG"
  rm -rf "$STAGE"
  exit 3
fi

echo "[updater] $NEWDIR -> $INSTALL" >> "$LOG"
if ! mv "$NEWDIR" "$INSTALL" >> "$LOG" 2>&1; then
  echo "[updater] ERROR: move-in failed; rolling back" >> "$LOG"
  mv "$BACKUP" "$INSTALL" >> "$LOG" 2>&1 || true
  rm -rf "$STAGE"
  exit 4
fi
rm -rf "$STAGE"

# 4. Relaunch.
echo "[updater] launching $INSTALL/start.sh --port $PORT --no-open" >> "$LOG"
cd "$INSTALL"
nohup "$INSTALL/start.sh" --port "$PORT" --no-open >> "$LOG" 2>&1 &
disown
echo "[updater] OK (backup at $BACKUP)" >> "$LOG"
exit 0
