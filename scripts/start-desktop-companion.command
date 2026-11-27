#!/bin/sh
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

if [ ! -f "$ROOT/runtime/node" ]; then
  echo "Bundled Node runtime is missing."
  echo "Please extract the complete macOS package before starting the canvas."
  printf "Press Return to close..."
  read -r ignored
  exit 1
fi

if [ ! -x "$ROOT/runtime/node" ]; then
  chmod +x "$ROOT/runtime/node" || {
    echo "Unable to make the bundled runtime executable."
    printf "Press Return to close..."
    read -r ignored
    exit 1
  }
fi

"$ROOT/runtime/node" "$ROOT/scripts/start-desktop-companion.mjs"
status=$?
if [ "$status" -ne 0 ]; then
  echo
  echo "Canvas failed to start. Check start.log in this folder."
  printf "Press Return to close..."
  read -r ignored
fi
exit "$status"
