#!/bin/bash
# Double-clickable launcher for macOS.
#
# Runs from the folder this script lives in, regardless of where Finder or the
# Terminal happened to be. That is the whole point: npm looks for package.json
# in the current folder and upward, so launching from anywhere else fails with
# a confusing "Could not read package.json".
cd "$(dirname "$0")" || exit 1

echo
echo "  SpaceRSS"
echo "  ========"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js does not appear to be installed."
  echo
  echo "  Install the LTS version from https://nodejs.org"
  echo "  then close this window and open this file again."
  echo
  read -r -p "  Press Return to close." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run - installing dependencies. This takes about a minute."
  echo
  if ! npm ci --ignore-scripts; then
    echo
    echo "  Dependency install failed. The messages above say why."
    echo
    read -r -p "  Press Return to close." _
    exit 1
  fi
  echo
fi

# Match whatever port the server will actually use, so an overridden PORT does
# not send the browser to the wrong address.
OPEN_PORT="${PORT:-4000}"

echo "  Starting SpaceRSS. Your browser will open in a few seconds."
echo "  If it does not, go to http://localhost:${OPEN_PORT}"
echo
echo "  Leave this window open while you use it."
echo "  Press Ctrl+C, or close this window, to stop."
echo

# Open the browser slightly behind the server so the first request does not
# land before it is listening. Backgrounded so it does not block startup.
( sleep 4; open "http://localhost:${OPEN_PORT}" ) >/dev/null 2>&1 &

npm start

echo
echo "  SpaceRSS has stopped."
echo
read -r -p "  Press Return to close." _
