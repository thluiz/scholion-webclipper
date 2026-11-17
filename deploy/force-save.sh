#!/bin/bash
# force-save.sh — the author's conscious override of the ghost-audit gate
# (webclip.save.force, README Decision 3) for operations the author accepted
# as-is. Run it yourself, on the host, as the service user:
#
#   wsl -d HermesTools -u hermes -- bash -c "bash /home/hermes/services/scholion-webclipper/deploy/force-save.sh <operationId> [...]"
#
# It reads the admin principal's key from acl.json on the host and never
# prints it. Mode "commit": the service writes, commits and pushes its own
# clone; an existing draft of the same page is replaced (Decision 11).
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <operationId> [operationId...]" >&2; exit 2; }
cd "$(dirname "$0")/.."
PRINCIPAL="${FORCE_PRINCIPAL:-thiago}"
KEY=$(PRINCIPAL="$PRINCIPAL" python3 -c '
import json, os
a = json.load(open("acl.json"))
p = a.get("principals", a)
p = p if isinstance(p, list) else [dict(name=k, **v) for k, v in p.items()]
print([x["apiKey"] for x in p if x.get("name") == os.environ["PRINCIPAL"] and x.get("role") == "admin"][0])')
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || true)
for OP in "$@"; do
  echo "== $OP"
  curl -s -m 120 -X POST "http://127.0.0.1:${PORT:-8020}/webclip/$OP/save" \
    -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
    -d '{"mode":"commit","force":true}'
  echo
done
