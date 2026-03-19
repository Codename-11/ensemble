#!/usr/bin/env bash
# collab-status.sh — live dashboard for active and recent collabs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

ORCHESTRA_ROOT="/tmp/orchestra"
REFRESH_SECONDS="${COLLAB_STATUS_REFRESH:-5}"
WATCH=1

G='\033[92m'
Y='\033[93m'
RRED='\033[91m'
C='\033[96m'
W='\033[97m'
D='\033[2m'
BD='\033[1m'
RESET='\033[0m'

usage() {
  cat <<'EOF'
Usage: collab-status.sh [--once] [--interval SECONDS]

Options:
  --once               Print one snapshot and exit.
  --interval SECONDS   Refresh interval for the live dashboard. Default: 5.
  -h, --help           Show this help text.
EOF
}

mtime_epoch() {
  local path="${1:?path required}"
  if stat -f '%m' "$path" >/dev/null 2>&1; then
    stat -f '%m' "$path"
  else
    stat -c '%Y' "$path"
  fi
}

trim_text() {
  local text="${1:-}"
  local max="${2:-52}"
  text="$(printf '%s' "$text" | tr '\n' ' ' | tr '\t' ' ' | sed 's/[[:space:]][[:space:]]*/ /g; s/^ //; s/ $//')"
  if [ "${#text}" -gt "$max" ]; then
    printf '%s…' "${text:0:$((max - 1))}"
  else
    printf '%s' "$text"
  fi
}

human_duration() {
  local seconds="${1:-0}"
  if [ "$seconds" -lt 0 ]; then
    seconds=0
  fi

  local days hours minutes
  days=$((seconds / 86400))
  hours=$(((seconds % 86400) / 3600))
  minutes=$(((seconds % 3600) / 60))

  if [ "$days" -gt 0 ]; then
    printf '%sd %sh' "$days" "$hours"
  elif [ "$hours" -gt 0 ]; then
    printf '%sh %sm' "$hours" "$minutes"
  else
    printf '%sm' "$minutes"
  fi
}

summary_duration() {
  local summary_file="${1:-}"
  [ -f "$summary_file" ] || return 1
  sed -n 's/^Duration:[[:space:]]*//p' "$summary_file" | head -n 1
}

detect_team_name() {
  local runtime_dir="${1:?runtime dir required}"
  local base delivery_file delivery_name

  base="$(basename "$runtime_dir")"
  delivery_file="$(find "$runtime_dir/delivery" -maxdepth 1 -type f -name '*.txt' 2>/dev/null | head -n 1 || true)"
  if [ -n "$delivery_file" ]; then
    delivery_name="$(basename "$delivery_file" .txt)"
    delivery_name="${delivery_name%-codex-1}"
    delivery_name="${delivery_name%-claude-2}"
    if [ -n "$delivery_name" ]; then
      printf '%s' "$delivery_name"
      return 0
    fi
  fi

  printf '%s' "$base"
}

detect_agents() {
  local runtime_dir="${1:?runtime dir required}"
  local prompts_dir agent_list file agent

  prompts_dir="$runtime_dir/prompts"
  agent_list=""
  if [ -d "$prompts_dir" ]; then
    for file in "$prompts_dir"/*.txt; do
      [ -e "$file" ] || continue
      agent="$(basename "$file" .txt)"
      if [ -n "$agent_list" ]; then
        agent_list="$agent_list, $agent"
      else
        agent_list="$agent"
      fi
    done
  fi

  if [ -n "$agent_list" ]; then
    printf '%s' "$agent_list"
  else
    printf '%s' "-"
  fi
}

is_collab_dir() {
  local runtime_dir="${1:?runtime dir required}"
  local base

  [ -d "$runtime_dir" ] || return 1
  base="$(basename "$runtime_dir")"
  case "$base" in
    team-say-*)
      return 1
      ;;
  esac

  [ -f "$runtime_dir/messages.jsonl" ] && return 0
  [ -f "$runtime_dir/team-id" ] && return 0
  [ -f "$runtime_dir/.finished" ] && return 0
  [ -f "$runtime_dir/summary.txt" ] && return 0
  return 1
}

collect_last_activity() {
  local runtime_dir="${1:?runtime dir required}"
  local last_ts=0 path

  for path in \
    "$runtime_dir" \
    "$runtime_dir/messages.jsonl" \
    "$runtime_dir/feed.txt" \
    "$runtime_dir/bridge.log" \
    "$runtime_dir/summary.txt" \
    "$runtime_dir/.finished" \
    "$runtime_dir/bridge.pid" \
    "$runtime_dir/poller.pid"; do
    if [ -e "$path" ]; then
      ts="$(mtime_epoch "$path")"
      if [ "$ts" -gt "$last_ts" ]; then
        last_ts="$ts"
      fi
    fi
  done

  if [ -d "$runtime_dir/prompts" ]; then
    for path in "$runtime_dir/prompts"/*.txt; do
      [ -e "$path" ] || continue
      ts="$(mtime_epoch "$path")"
      if [ "$ts" -gt "$last_ts" ]; then
        last_ts="$ts"
      fi
    done
  fi

  if [ -d "$runtime_dir/delivery" ]; then
    for path in "$runtime_dir/delivery"/*.txt; do
      [ -e "$path" ] || continue
      ts="$(mtime_epoch "$path")"
      if [ "$ts" -gt "$last_ts" ]; then
        last_ts="$ts"
      fi
    done
  fi

  printf '%s\n' "$last_ts"
}

message_meta() {
  local messages_file="${1:?messages file required}"
  python3 - "$messages_file" <<'PY'
import json
import sys

path = sys.argv[1]
count = 0
first_ts = ""
last_ts = ""
last_content = ""

try:
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            count += 1
            ts = msg.get("timestamp") or ""
            if not first_ts and ts:
                first_ts = ts
            if ts:
                last_ts = ts
            content = str(msg.get("content", "")).replace("\n", " ").replace("\t", " ").strip()
            if content:
                last_content = " ".join(content.split())
except FileNotFoundError:
    pass

print(count)
print(first_ts)
print(last_ts)
print(last_content)
PY
}

render_snapshot() {
  local now team_count=0 active_count=0 finished_count=0 stale_count=0 total_messages=0
  local temp_file runtime_dir base team_name messages_file finished_marker summary_file
  local sort_group last_activity status_color status messages_count first_ts last_ts last_message
  local duration_seconds duration_text agents status_label age_seconds

  now="$(date +%s)"
  temp_file="$(mktemp)"

  for runtime_dir in "$ORCHESTRA_ROOT"/*; do
    [ -d "$runtime_dir" ] || continue
    if ! is_collab_dir "$runtime_dir"; then
      continue
    fi

    base="$(basename "$runtime_dir")"
    messages_file="$(collab_messages_file "$base")"
    finished_marker="$(collab_finished_marker "$base")"
    summary_file="$(collab_summary_file "$base")"
    team_name="$(detect_team_name "$runtime_dir")"
    agents="$(detect_agents "$runtime_dir")"
    last_activity="$(collect_last_activity "$runtime_dir")"
    messages_count=0
    first_ts=""
    last_ts=""
    last_message=""

    if [ -f "$messages_file" ]; then
      exec 3< <(message_meta "$messages_file")
      IFS= read -r messages_count <&3 || true
      IFS= read -r first_ts <&3 || true
      IFS= read -r last_ts <&3 || true
      IFS= read -r last_message <&3 || true
      exec 3<&-
    fi

    if [ -f "$finished_marker" ]; then
      status="finished"
      sort_group="1"
      finished_count=$((finished_count + 1))
    else
      age_seconds=$((now - last_activity))
      if [ "$age_seconds" -gt 3600 ]; then
        status="stale"
        sort_group="2"
        stale_count=$((stale_count + 1))
      else
        status="active"
        sort_group="0"
        active_count=$((active_count + 1))
      fi
    fi

    total_messages=$((total_messages + messages_count))
    team_count=$((team_count + 1))

    duration_text="$(summary_duration "$summary_file" || true)"
    if [ -z "$duration_text" ]; then
      if [ -n "$first_ts" ] && [ -n "$last_ts" ]; then
        duration_seconds="$(python3 - "$first_ts" "$last_ts" <<'PY'
import sys
from datetime import datetime
start = datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00"))
end = datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
print(int((end - start).total_seconds()))
PY
)"
        duration_text="$(human_duration "$duration_seconds")"
      else
        duration_text="-"
      fi
    fi

    if [ -z "$last_message" ] && [ -f "$summary_file" ]; then
      last_message="$(sed -n 's/^Task:[[:space:]]*//p' "$summary_file" | head -n 1)"
    fi
    if [ -z "$last_message" ]; then
      last_message="-"
    fi
    last_message="$(trim_text "$last_message" 56)"

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$sort_group" "$last_activity" "$team_name" "$status" "$messages_count" "$last_message" "$duration_text" "$agents" >> "$temp_file"
  done

  if [ "$WATCH" -eq 1 ]; then
    clear
  fi
  echo ""
  echo -e "  ${BD}${W}◈ collab status${RESET}"
  echo -e "  ${D}${ORCHESTRA_ROOT}${RESET}"
  echo ""
  printf '  %-24s %-10s %8s %-58s %-10s %s\n' "Team" "Status" "Msgs" "Last Message" "Duration" "Agents"
  echo -e "  ${D}$(printf '%.0s─' $(seq 1 132))${RESET}"

  if [ ! -s "$temp_file" ]; then
    echo -e "  ${D}No collab runtime directories found.${RESET}"
  else
    while IFS=$'\t' read -r sort_group last_activity team_name status messages_count last_message duration_text agents; do
      case "$status" in
        active)
          status_color="$G"
          status_label="active"
          ;;
        finished)
          status_color="$Y"
          status_label="finished"
          ;;
        stale)
          status_color="$RRED"
          status_label="stale"
          ;;
        *)
          status_color="$W"
          status_label="$status"
          ;;
      esac

      printf '  %-24s %b%-10s%b %8s %-58s %-10s %s\n' \
        "$team_name" "$status_color" "$status_label" "$RESET" "$messages_count" "$last_message" "$duration_text" "$agents"
    done < <(sort -t $'\t' -k1,1n -k2,2nr "$temp_file")
  fi

  echo ""
  if [ "$WATCH" -eq 1 ]; then
    echo -e "  ${BD}Stats${RESET} ${D}(refresh ${REFRESH_SECONDS}s)${RESET}"
  else
    echo -e "  ${BD}Stats${RESET}"
  fi
  echo -e "  total collabs: ${team_count} | ${G}active ${active_count}${RESET} | ${Y}finished ${finished_count}${RESET} | ${RRED}stale ${stale_count}${RESET} | messages ${total_messages}"
  echo ""

  rm -f "$temp_file"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --once)
      WATCH=0
      ;;
    --interval)
      shift
      REFRESH_SECONDS="${1:?missing interval seconds}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if [ ! -d "$ORCHESTRA_ROOT" ]; then
  printf '%sRuntime root not found: %s%s\n' "$Y" "$ORCHESTRA_ROOT" "$RESET" >&2
  exit 0
fi

if [ "$WATCH" -eq 0 ]; then
  render_snapshot
  exit 0
fi

trap 'printf "\n"; exit 0' INT TERM

while true; do
  render_snapshot
  sleep "$REFRESH_SECONDS"
done
