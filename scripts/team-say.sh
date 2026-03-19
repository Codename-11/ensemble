#!/usr/bin/env bash
# team-say — Send a message to your team feed
# Works inside sandboxed environments (no network needed - writes to file)
# Usage: team-say <team-id> <from> <to> <message>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

TEAM_ID="$1"; FROM="$2"; TO="$3"; shift 3; MSG="$*"
FILE="$(collab_messages_file "$TEAM_ID")"
DIR="$(dirname "$FILE")"
LOCK_FILE="$FILE.lock"
mkdir -p "$DIR"
touch "$FILE" "$LOCK_FILE"
python3 -c "
import fcntl
import json
import sys
import uuid
from datetime import datetime, timezone

team_id, sender, recipient, content, output_path, lock_path = sys.argv[1:7]
msg = {
    'id': str(uuid.uuid4()),
    'teamId': team_id,
    'from': sender,
    'to': recipient,
    'content': content,
    'type': 'chat',
    'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
}

with open(lock_path, 'w', encoding='utf-8') as lock_handle:
    fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
    with open(output_path, 'a', encoding='utf-8') as output_handle:
        output_handle.write(json.dumps(msg) + '\n')
    fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
" "$TEAM_ID" "$FROM" "$TO" "$MSG" "$FILE" "$LOCK_FILE"

echo "Sent to $TO"
