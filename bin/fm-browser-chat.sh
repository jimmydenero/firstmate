#!/usr/bin/env bash
# fm-browser-chat.sh - reach the local browser chat page of this home's primary
# Pi session.
#
# docs/browser-chat.md owns setup, supported limits, and the security model.
# The server itself is .pi/extensions/fm-browser-chat.ts; this script only reads
# what that extension publishes and never starts, stops, or changes it.
#
# Usage:
#   fm-browser-chat.sh status   print whether the page is on and where (no token)
#   fm-browser-chat.sh url      print the full access link, token included
#   fm-browser-chat.sh copy     copy the full access link to the clipboard
#   fm-browser-chat.sh open     open the full access link in the default browser
#
# The access link carries the token in its #fragment, which the browser never
# sends to the server; the page moves it into this origin's storage. Treat the
# printed link like a password: anyone holding it on this machine can talk to
# Firstmate as you.
#
# Files read (all under the home's state/extensions/browser-chat/):
#   endpoint.json   written by the extension while it serves; removed on stop
#   token           the access token, mode 600, stable across restarts
#
# Exit status: 0 success; 1 the page is not running or the request failed;
# 2 usage error.
#
# Environment:
#   FM_HOME             operational home (default: this repository)
#   FM_STATE_OVERRIDE   state directory override
#   FM_CONFIG_OVERRIDE  config directory override
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FM_HOME="${FM_HOME:-$(cd "$SELF_DIR/.." && pwd)}"
STATE="${FM_STATE_OVERRIDE:-$FM_HOME/state}"
CONFIG="${FM_CONFIG_OVERRIDE:-$FM_HOME/config}"
WORK="$STATE/extensions/browser-chat"

die() { printf 'fm-browser-chat: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '9,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# Prints "<port> <pid>" for a live published endpoint, or fails with a reason.
endpoint() {
  [ -f "$CONFIG/browser-chat" ] || die "browser chat is off; create $CONFIG/browser-chat, then run /reload (or /browser-chat) in the primary Pi session"
  [ -r "$WORK/endpoint.json" ] || die "browser chat is on but not serving; the primary Pi session must hold the session lock and have loaded the extension (run /reload there)"
  python3 - "$WORK/endpoint.json" <<'PY'
import json, os, sys
try:
    data = json.load(open(sys.argv[1]))
    port, pid = int(data["port"]), int(data["pid"])
except Exception:
    sys.exit("fm-browser-chat: endpoint record is unreadable")
try:
    os.kill(pid, 0)
except ProcessLookupError:
    sys.exit("fm-browser-chat: the Pi session that served the page has exited; restart or /reload the primary session")
except PermissionError:
    pass
print(port, pid)
PY
}

access_url() {
  local port token
  read -r port _ < <(endpoint) || exit 1
  [ -r "$WORK/token" ] || die "access token missing at $WORK/token"
  token=$(tr -d '[:space:]' <"$WORK/token")
  [ -n "$token" ] || die "access token is empty at $WORK/token"
  printf 'http://127.0.0.1:%s/#token=%s\n' "$port" "$token"
}

case "${1:-}" in
  status)
    read -r port pid < <(endpoint) || exit 1
    printf 'on: http://127.0.0.1:%s/ served by Pi pid %s\n' "$port" "$pid"
    ;;
  url)
    access_url
    ;;
  copy)
    url=$(access_url) || exit 1
    command -v pbcopy >/dev/null 2>&1 || die "no pbcopy here; use: $(basename "$0") url"
    printf '%s' "$url" | pbcopy
    printf 'copied the browser chat link to the clipboard\n'
    ;;
  open)
    url=$(access_url) || exit 1
    if command -v open >/dev/null 2>&1; then
      open "$url"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url" >/dev/null 2>&1
    else
      die "no browser opener found; use: $(basename "$0") url"
    fi
    ;;
  *)
    usage
    ;;
esac
