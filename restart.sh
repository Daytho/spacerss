#!/usr/bin/env bash
# Restart the SpaceRSS node process detached from the calling shell.
#
# Kills by pidfile rather than `pkill -f "node server/index.js"`, which also
# matches the calling shell's own command line and takes the caller down with it.
set -euo pipefail

cd "$(dirname "$0")"
PIDFILE="./data/spacerss.pid"
LOGFILE="${SPACERSS_LOG:-/tmp/spacerss-server.log}"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# nvm.sh references unbound variables internally, so relax `set -u` while sourcing it.
set +u
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null && nvm use --lts >/dev/null
set -u

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")"
  for _ in $(seq 20); do
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
    sleep 0.2
  done
fi
rm -f "$PIDFILE"

setsid nohup node server/index.js > "$LOGFILE" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
disown || true

for _ in $(seq 30); do
  if curl -sf -o /dev/null http://127.0.0.1:"${PORT:-4000}"/ ; then
    echo "spacerss restarted (pid $(cat "$PIDFILE"))"
    exit 0
  fi
  sleep 0.3
done

echo "spacerss failed to come up; last log lines:" >&2
tail -20 "$LOGFILE" >&2
exit 1
