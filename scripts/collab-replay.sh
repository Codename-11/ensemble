#!/usr/bin/env bash
# collab-replay.sh — Replay a past collab session in the terminal
# Usage: collab-replay.sh <team-id> [--speed N] [--verbose]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

usage() {
  cat <<'EOF'
Usage: collab-replay.sh <team-id> [--speed N] [--verbose]

  --speed N    Playback speed multiplier (default: 1, 0 = instant)
  --verbose    Show agent-forge system messages if present
  -h, --help   Show this help
EOF
}

TEAM_ID=""
SPEED="1"
VERBOSE="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --speed)
      [ "$#" -ge 2 ] || {
        echo "Error: --speed requires a number" >&2
        usage >&2
        exit 1
      }
      SPEED="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$TEAM_ID" ]; then
        echo "Error: unexpected argument: $1" >&2
        usage >&2
        exit 1
      fi
      TEAM_ID="$1"
      shift
      ;;
  esac
done

if [ -z "$TEAM_ID" ]; then
  echo "Error: team-id required" >&2
  usage >&2
  exit 1
fi

if ! python3 - "$SPEED" <<'PY'
import sys

try:
    value = float(sys.argv[1])
except ValueError:
    raise SystemExit(1)

if value < 0:
    raise SystemExit(1)
PY
then
  echo "Error: --speed must be a number >= 0" >&2
  exit 1
fi

JSONL="$(collab_messages_file "$TEAM_ID")"
if [ ! -f "$JSONL" ]; then
  echo "Error: messages file not found: $JSONL" >&2
  exit 1
fi

TMP_DIR="${TMPDIR:-/tmp}"
EVENTS_FILE="$(mktemp "$TMP_DIR/collab-replay-events.XXXXXX")"
META_FILE="$(mktemp "$TMP_DIR/collab-replay-meta.XXXXXX")"

cleanup() {
  rm -f "$EVENTS_FILE" "$META_FILE"
}

trap cleanup EXIT INT TERM

python3 - "$JSONL" "$TEAM_ID" "$VERBOSE" "$EVENTS_FILE" "$META_FILE" <<'PY'
import json
import sys
from collections import Counter
from datetime import datetime, timezone

jsonl_path, team_id, verbose, events_path, meta_path = sys.argv[1:6]
verbose = verbose == "1"

def parse_timestamp(value):
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None

events = []
total_messages = 0
skipped_agent-forge = 0
agent_counter = Counter()
first_dt = None
last_dt = None

with open(jsonl_path, "r", encoding="utf-8") as handle:
    for line in handle:
        raw = line.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue

        total_messages += 1
        sender = str(msg.get("from", "?"))
        timestamp = str(msg.get("timestamp", ""))
        content = str(msg.get("content", "")).replace("\r\n", "\n").replace("\r", "\n")
        msg_type = str(msg.get("type", ""))
        dt = parse_timestamp(timestamp)

        if dt is not None:
            if first_dt is None or dt < first_dt:
                first_dt = dt
            if last_dt is None or dt > last_dt:
                last_dt = dt

        if sender == "agent-forge" and not verbose:
            skipped_agent-forge += 1
            continue

        if dt is None:
            continue

        agent_counter[sender] += 1
        display_ts = dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")
        events.append({
            "epoch": dt.timestamp(),
            "display_ts": display_ts,
            "sender": sender,
            "type": msg_type,
            "content": content,
        })

events.sort(key=lambda item: item["epoch"])

with open(events_path, "w", encoding="utf-8") as handle:
    for event in events:
        row = [
            "{0:.6f}".format(event["epoch"]),
            event["display_ts"],
            event["sender"].replace("\t", "    "),
            event["type"].replace("\t", "    "),
            event["content"].replace("\t", "    "),
        ]
        handle.write("\t".join(row))
        handle.write("\n")

duration_seconds = 0.0
if first_dt is not None and last_dt is not None:
    duration_seconds = max(0.0, (last_dt - first_dt).total_seconds())

agent_summary = ", ".join(
    "{0}:{1}".format(sender, agent_counter[sender])
    for sender in sorted(agent_counter)
)

with open(meta_path, "w", encoding="utf-8") as handle:
    handle.write("team_id={0}\n".format(team_id))
    handle.write("total_messages={0}\n".format(total_messages))
    handle.write("rendered_messages={0}\n".format(len(events)))
    handle.write("skipped_agent-forge={0}\n".format(skipped_agent-forge))
    handle.write("duration_seconds={0:.3f}\n".format(duration_seconds))
    handle.write("started_at={0}\n".format(first_dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z") if first_dt else "unknown"))
    handle.write("ended_at={0}\n".format(last_dt.astimezone().strftime("%Y-%m-%d %H:%M:%S %Z") if last_dt else "unknown"))
    handle.write("agents={0}\n".format(agent_summary or "none"))
PY

TOTAL_MESSAGES="0"
RENDERED_MESSAGES="0"
SKIPPED_AGENT_FORGE="0"
DURATION_SECONDS="0"
STARTED_AT="unknown"
ENDED_AT="unknown"
AGENTS="none"

while IFS='=' read -r key value; do
  case "$key" in
    total_messages) TOTAL_MESSAGES="$value" ;;
    rendered_messages) RENDERED_MESSAGES="$value" ;;
    skipped_agent-forge) SKIPPED_AGENT_FORGE="$value" ;;
    duration_seconds) DURATION_SECONDS="$value" ;;
    started_at) STARTED_AT="$value" ;;
    ended_at) ENDED_AT="$value" ;;
    agents) AGENTS="$value" ;;
  esac
done < "$META_FILE"

# Colors from collab-livefeed.sh
C1='\033[96m'
C2='\033[93m'
W='\033[97m'
G='\033[92m'
D='\033[2m'
BD='\033[1m'
R='\033[0m'

speed_label="${SPEED}x"
case "$SPEED" in
  0|0.0|0.00) speed_label="instant" ;;
esac

echo ""
echo -e "  ${BD}${W}◈ Session replay${R}"
echo -e "  ${D}─────────────────────────────────────────${R}"
echo -e "  ${W}Team${R}   ${D}│${R} ${TEAM_ID}"
echo -e "  ${W}Speed${R}  ${D}│${R} ${speed_label}"
echo -e "  ${W}Start${R}  ${D}│${R} ${STARTED_AT}"
echo -e "  ${W}End${R}    ${D}│${R} ${ENDED_AT}"
echo -e "  ${W}Agents${R} ${D}│${R} ${AGENTS}"
echo -e "  ${D}─────────────────────────────────────────${R}"

if [ "$RENDERED_MESSAGES" = "0" ]; then
  echo -e "  ${D}No replayable messages found.${R}"
else
  PREV_EPOCH=""
  while IFS=$'\t' read -r epoch display_ts sender msg_type content; do
    [ -n "$epoch" ] || continue

    if [ "$SPEED" != "0" ] && [ "$SPEED" != "0.0" ] && [ -n "$PREV_EPOCH" ]; then
      python3 - "$PREV_EPOCH" "$epoch" "$SPEED" <<'PY'
import sys
import time

prev_ts = float(sys.argv[1])
current_ts = float(sys.argv[2])
speed = float(sys.argv[3])
delay = max(0.0, current_ts - prev_ts) / speed
if delay > 0:
    time.sleep(delay)
PY
    fi

    case "$sender" in
      codex-1)  color="$C1" ;;
      claude-2) color="$C2" ;;
      agent-forge) color="$W" ;;
      *)        color="$W" ;;
    esac

    while IFS= read -r line || [ -n "$line" ]; do
      printf '  %b%s%b %b│%b %b[%s]%b %s\n' \
        "$color" "$sender" "$R" "$D" "$R" "$D" "$display_ts" "$R" "$line"
    done <<EOF
$content
EOF

    PREV_EPOCH="$epoch"
  done < "$EVENTS_FILE"
fi

echo ""
echo -e "  ${D}─────────────────────────────────────────${R}"
echo -e "  ${BD}${G}◈ Replay complete${R}"
echo -e "  ${W}Visible${R} ${D}│${R} ${RENDERED_MESSAGES} messages"
echo -e "  ${W}Total${R}   ${D}│${R} ${TOTAL_MESSAGES} messages"
echo -e "  ${W}Hidden${R}  ${D}│${R} ${SKIPPED_AGENT_FORGE} agent-forge"
echo -e "  ${W}Span${R}    ${D}│${R} ${DURATION_SECONDS} seconds"
