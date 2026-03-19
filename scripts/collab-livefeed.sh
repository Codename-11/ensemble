#!/usr/bin/env bash
# collab-livefeed.sh — Live colored message feed for non-tmux sessions
# Usage: collab-livefeed.sh <team-id>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

TEAM_ID="${1:?Usage: collab-livefeed.sh <team-id>}"
JSONL="$(collab_messages_file "$TEAM_ID")"
SUMMARY="$(collab_summary_file "$TEAM_ID")"
FINISHED="$(collab_finished_marker "$TEAM_ID")"
SEEN=0
LAST_OUTPUT_TS="$(date +%s)"

# Colors
C1='\033[96m'   # cyan for codex-1
C2='\033[93m'   # yellow for claude-2
W='\033[97m'    # white
G='\033[92m'    # green
D='\033[2m'     # dim
BD='\033[1m'    # bold
R='\033[0m'     # reset

echo ""
echo -e "  ${BD}${W}◈ Live feed${R} — berichten verschijnen hieronder"
echo -e "  ${D}─────────────────────────────────────────${R}"

cleanup() {
  echo ""
}

trap cleanup EXIT INT TERM

print_new_messages() {
  local file="$1" skip="$2"
  python3 - "$file" "$skip" <<'PY'
import json
import sys

file_path = sys.argv[1]
skip = int(sys.argv[2])

try:
    with open(file_path, "r", encoding="utf-8") as handle:
        lines = handle.readlines()[skip:]
except FileNotFoundError:
    lines = []

for raw in lines:
    line = raw.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    sender = msg.get("from", "?")
    if sender == "orchestra":
        continue
    content = str(msg.get("content", "")).replace("/tmp/orchestra/", "").replace("/tmp/orchestra-msgs/", "").strip()[:200]
    print(f"{sender}\t{content}")
PY
}

while true; do
  # Team disbanded? Print remaining + summary
  if [ -f "$FINISHED" ] || [ -f "$SUMMARY" ]; then
    TOTAL=$(wc -l < "$JSONL" 2>/dev/null | tr -d ' ') || TOTAL=0
    if [ "${TOTAL:-0}" -gt "$SEEN" ]; then
      while IFS=$'\t' read -r from content; do
        [ -z "${from:-}" ] && continue
        case "$from" in
          codex-1)  color="$C1" ;;
          claude-2) color="$C2" ;;
          *)        color="$W" ;;
        esac
        echo -e "  ${color}${from}${R} ${D}│${R} ${content}"
      done < <(print_new_messages "$JSONL" "$SEEN")
    fi
    echo ""
    echo -e "  ${D}─────────────────────────────────────────${R}"
    echo -e "  ${BD}${G}◈ Team afgerond${R}"
    echo ""
    [ -f "$SUMMARY" ] && cat "$SUMMARY"
    exit 0
  fi

  # New messages?
  TOTAL=$(wc -l < "$JSONL" 2>/dev/null | tr -d ' ') || TOTAL=0
  if [ "${TOTAL:-0}" -gt "$SEEN" ]; then
    while IFS=$'\t' read -r from content; do
      [ -z "${from:-}" ] && continue
      case "$from" in
        codex-1)  color="$C1" ;;
        claude-2) color="$C2" ;;
        *)        color="$W" ;;
      esac
      echo -e "  ${color}${from}${R} ${D}│${R} ${content}"
    done < <(print_new_messages "$JSONL" "$SEEN")
    SEEN=$TOTAL
    LAST_OUTPUT_TS="$(date +%s)"
  else
    NOW_TS="$(date +%s)"
    if [ $((NOW_TS - LAST_OUTPUT_TS)) -ge 10 ]; then
      echo -ne "."
      LAST_OUTPUT_TS="$NOW_TS"
    fi
  fi
  sleep 5
done
