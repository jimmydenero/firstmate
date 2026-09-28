#!/usr/bin/env bash
# Tests for the browser chat: the Pi extension over real loopback HTTP (opt-in,
# lock ownership, auth, origin and host refusal, streaming, duplicate-free
# delivery and reconnect), the page's Markdown and exact-link copying, its
# clipboard and speech fallbacks, and bin/fm-browser-chat.sh.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TMP_ROOT=$(fm_test_tmproot fm-browser-chat)
PLUGIN="$ROOT/.pi/extensions/fm-browser-chat.ts"
ASSETS="$ROOT/.pi/extensions/lib/browser-chat"
DRIVER="$ROOT/tests/fm-browser-chat-driver.mjs"
SCRIPT="$ROOT/bin/fm-browser-chat.sh"
export NODE_NO_WARNINGS=1

command -v node >/dev/null 2>&1 || { echo "skip: node is required for the browser chat tests"; exit 0; }
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "skip: node 22 or newer is required to load the TypeScript extension (found $(node --version))"
  exit 0
fi

new_home() {
  local home
  home=$(mktemp -d "$TMP_ROOT/home.XXXXXX")
  mkdir -p "$home/state" "$home/config"
  printf '%s\n' "$home"
}

run_scenario() {
  local scenario=$1 home out
  home=$(new_home)
  printf 'check: synthetic wake' | "$ROOT/bin/fm-operational-input.sh" encode watcher >"$home/operational-sample"
  out=$(PLUGIN="$PLUGIN" ASSETS="$ASSETS" FM_HOME="$home" OPERATIONAL_SAMPLE="$home/operational-sample" \
    node "$DRIVER" "$scenario" 2>&1) || fail "$scenario: $out"
  printf '%s\n' "$out"
}

test_extension_is_off_without_config() {
  run_scenario off-by-default >/dev/null
  pass "browser chat serves nothing until config/browser-chat exists"
}

test_extension_requires_session_lock() {
  run_scenario lock-held-elsewhere >/dev/null
  pass "a Pi session that does not hold the session lock never serves"
}

test_security_boundary() {
  run_scenario security-boundary >/dev/null
  pass "token, Host, Origin and Sec-Fetch-Site checks refuse foreign requests; private files are mode 600"
}

test_conversation_stream_reconnect_and_dedupe() {
  local out
  out=$(run_scenario conversation) || exit 1
  assert_contains "$out" "transport_ms=" "conversation scenario reports transport latency"
  pass "streams replies, delivers each request id once across retries and reloads, and reconnects without loss or duplicates ($(printf '%s\n' "$out" | grep -o 'transport_ms=[0-9]*'))"
}

test_operational_and_tool_projection() {
  run_scenario operational-and-tools >/dev/null
  pass "Firstmate notifications and tool activity are marked so the page can fold them"
}

test_session_replacement_serves_again() {
  run_scenario session-replacement >/dev/null
  pass "after /new, /resume or /fork the same Pi instance serves the new session from a clean slate, and a final quit stays down"
}

test_notices_and_custom_messages_appear_once() {
  run_scenario notices-and-custom >/dev/null
  pass "compaction notices and displayed custom messages appear once after reconnect"
}

test_start_failure_backs_off() {
  run_scenario start-failure-backoff >/dev/null
  pass "a failed start warns once and waits for the flag file to change before retrying"
}

test_markdown_is_safe_and_links_are_exact() {
  run_scenario markdown >/dev/null
  pass "Markdown renders untrusted text safely and link copy uses exact original URL bytes in display order"
}

test_client_fallbacks() {
  run_scenario client >/dev/null
  pass "clipboard falls back to a manual-copy dialog, speech falls back to text, and split stream frames parse"
}

test_script_reports_state() {
  local home out status
  home=$(new_home)
  out=$(FM_HOME="$home" "$SCRIPT" url 2>&1) && fail "url must fail while off"
  assert_contains "$out" "browser chat is off" "off state explained"
  : >"$home/config/browser-chat"
  out=$(FM_HOME="$home" "$SCRIPT" status 2>&1) && fail "status must fail while not serving"
  assert_contains "$out" "not serving" "not-serving state explained"
  mkdir -p "$home/state/extensions/browser-chat"
  printf '{"version":1,"pid":%s,"port":45123,"url":"http://127.0.0.1:45123/"}\n' "$$" >"$home/state/extensions/browser-chat/endpoint.json"
  printf 'tok_EN-abcdefghijklmnopqrstuvwxyz0123456789\n' >"$home/state/extensions/browser-chat/token"
  out=$(FM_HOME="$home" "$SCRIPT" url) || fail "url: $out"
  assert_equals "$out" "http://127.0.0.1:45123/#token=tok_EN-abcdefghijklmnopqrstuvwxyz0123456789" "access URL"
  out=$(FM_HOME="$home" "$SCRIPT" status) || fail "status: $out"
  assert_not_contains "$out" "tok_EN" "status never prints the token"
  printf '{"version":1,"pid":999999,"port":45123}\n' >"$home/state/extensions/browser-chat/endpoint.json"
  out=$(FM_HOME="$home" "$SCRIPT" url 2>&1) && fail "url must fail for an exited server"
  assert_contains "$out" "has exited" "exited server explained"
  status=0
  FM_HOME="$home" "$SCRIPT" bogus >/dev/null 2>&1 || status=$?
  assert_equals "$status" "2" "usage error exit"
  pass "bin/fm-browser-chat.sh prints the access link only for a live page and explains every other state"
}

test_extension_is_off_without_config
test_extension_requires_session_lock
test_security_boundary
test_conversation_stream_reconnect_and_dedupe
test_operational_and_tool_projection
test_session_replacement_serves_again
test_notices_and_custom_messages_appear_once
test_start_failure_backs_off
test_markdown_is_safe_and_links_are_exact
test_client_fallbacks
test_script_reports_state
