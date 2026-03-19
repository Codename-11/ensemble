#!/usr/bin/env bash
# collab-cleanup.sh — Clean up old finished collab runtime directories.
# Usage: collab-cleanup.sh [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

ORCHESTRA_ROOT="/tmp/orchestra"
KEEP_RECENT=3
MIN_AGE_SECONDS=$((24 * 60 * 60))
MODE="dry-run"

G='\033[92m'; C='\033[96m'; D='\033[2m'; W='\033[97m'; Y='\033[93m'; R='\033[0m'; BD='\033[1m'

usage() {
  cat <<'EOF'
Usage: collab-cleanup.sh [--force]

Options:
  --force   Delete eligible runtime directories instead of printing a dry-run.
  -h, --help  Show this help text.
EOF
}

human_kb() {
  local kb="${1:-0}"
  if [ "$kb" -ge 1048576 ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f GB", kb / 1048576 }'
  elif [ "$kb" -ge 1024 ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f MB", kb / 1024 }'
  else
    printf '%s KB' "$kb"
  fi
}

mtime_epoch() {
  local path="${1:?path required}"
  if stat -f '%m' "$path" >/dev/null 2>&1; then
    stat -f '%m' "$path"
  else
    stat -c '%Y' "$path"
  fi
}

finished_entries() {
  [ -d "$ORCHESTRA_ROOT" ] || return 0
  find "$ORCHESTRA_ROOT" -mindepth 2 -maxdepth 2 -type f -name .finished -print0 |
    while IFS= read -r -d '' marker; do
      local runtime_dir ts
      runtime_dir="$(dirname "$marker")"
      ts="$(mtime_epoch "$marker")"
      printf '%s\t%s\n' "$ts" "$runtime_dir"
    done | sort -rn
}

for arg in "$@"; do
  case "$arg" in
    --force)
      MODE="force"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

NOW="$(date +%s)"
ENTRIES=()
while IFS= read -r line; do
  ENTRIES+=("$line")
done < <(finished_entries)

TOTAL_FINISHED="${#ENTRIES[@]}"
PRESERVED_RECENT=0
PRESERVED_FRESH=0
ELIGIBLE=0
REMOVED=0
FAILED=0
TOTAL_KB=0
REMOVED_KB=0

echo ""
echo -e "  ${BD}${W}◈ collab cleanup${R}"
echo -e "  ${D}${ORCHESTRA_ROOT}${R}"
echo -e "  ${D}mode: ${MODE} | keep latest ${KEEP_RECENT} | age threshold: 24h${R}"
echo ""

if [ ! -d "$ORCHESTRA_ROOT" ]; then
  echo -e "  ${Y}No runtime root found at ${ORCHESTRA_ROOT}${R}"
  exit 0
fi

if [ "$TOTAL_FINISHED" -eq 0 ]; then
  echo -e "  ${Y}No finished collabs found.${R}"
  exit 0
fi

for idx in "${!ENTRIES[@]}"; do
  entry="${ENTRIES[$idx]}"
  finished_ts="${entry%%$'\t'*}"
  runtime_dir="${entry#*$'\t'}"
  runtime_name="$(basename "$runtime_dir")"
  age_seconds=$((NOW - finished_ts))
  age_hours=$((age_seconds / 3600))
  size_kb="$(du -sk "$runtime_dir" 2>/dev/null | awk '{print $1}')"
  size_kb="${size_kb:-0}"
  TOTAL_KB=$((TOTAL_KB + size_kb))

  if [ "$idx" -lt "$KEEP_RECENT" ]; then
    PRESERVED_RECENT=$((PRESERVED_RECENT + 1))
    echo -e "  ${C}keep${R}    ${runtime_name} ${D}(latest $((idx + 1))/${KEEP_RECENT}, ${age_hours}h old, $(human_kb "$size_kb"))${R}"
    continue
  fi

  if [ "$age_seconds" -lt "$MIN_AGE_SECONDS" ]; then
    PRESERVED_FRESH=$((PRESERVED_FRESH + 1))
    echo -e "  ${C}skip${R}    ${runtime_name} ${D}(finished ${age_hours}h ago, below 24h threshold, $(human_kb "$size_kb"))${R}"
    continue
  fi

  ELIGIBLE=$((ELIGIBLE + 1))
  if [ "$MODE" = "force" ]; then
    if rm -rf "$runtime_dir"; then
      REMOVED=$((REMOVED + 1))
      REMOVED_KB=$((REMOVED_KB + size_kb))
      echo -e "  ${G}remove${R}  ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
    else
      FAILED=$((FAILED + 1))
      echo -e "  ${Y}failed${R}  ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
    fi
  else
    REMOVED_KB=$((REMOVED_KB + size_kb))
    echo -e "  ${Y}would rm${R} ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
  fi
done

echo ""
echo -e "  ${BD}Stats${R}"
echo -e "  finished dirs:      ${TOTAL_FINISHED}"
echo -e "  kept (latest 3):    ${PRESERVED_RECENT}"
echo -e "  kept (<24h):        ${PRESERVED_FRESH}"
echo -e "  eligible old dirs:  ${ELIGIBLE}"
if [ "$MODE" = "force" ]; then
  echo -e "  removed dirs:       ${REMOVED}"
  echo -e "  failed removals:    ${FAILED}"
  echo -e "  reclaimed:          $(human_kb "$REMOVED_KB")"
else
  echo -e "  would remove:       ${ELIGIBLE}"
  echo -e "  reclaimable:        $(human_kb "$REMOVED_KB")"
fi
echo -e "  finished footprint: $(human_kb "$TOTAL_KB")"
echo ""

if [ "$MODE" = "dry-run" ]; then
  echo -e "  ${D}Run with --force to delete eligible runtime directories.${R}"
  echo ""
fi
