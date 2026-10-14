#!/bin/bash
# Double-click in Finder to start KBS School ERP and open it in your browser.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "KBS School ERP needs Node.js 22.13 or newer. Download it from https://nodejs.org"
  read -r -n 1 -p "Press any key to close."
  exit 1
fi

PORT="${PORT:-3000}"
(sleep 1.5 && open "http://localhost:${PORT}") &
PORT="$PORT" exec node server/index.js
