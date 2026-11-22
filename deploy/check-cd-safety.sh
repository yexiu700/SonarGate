#!/usr/bin/env bash
# Static checks for the shared us-test deploy. No Docker daemon and no host access.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CD="$ROOT/.github/workflows/cd.yml"
COMPOSE="$ROOT/docker-compose.prod.yml"
DEPLOY="$ROOT/deploy/sonargate-deploy.sh"

fail() {
  echo "CD safety check failed: $*" >&2
  exit 1
}

[ -f "$CD" ] || fail "missing $CD"
[ -f "$COMPOSE" ] || fail "missing $COMPOSE"
[ -f "$DEPLOY" ] || fail "missing $DEPLOY"

bash -n "$DEPLOY"
bash -n "$0"

strip_comments() {
  sed -E 's/(^|[[:space:]])#.*$/\1/' "$1"
}

FORBIDDEN='prune|remove-orphans|compose[[:space:]]+down|[[:space:]]down[[:space:]]|nginx|systemctl|volume[[:space:]]+rm|network[[:space:]]+rm|docker[[:space:]]+rm|docker[[:space:]]+stop|docker[[:space:]]+kill'

for f in "$CD" "$DEPLOY"; do
  if strip_comments "$f" | grep -Ein "$FORBIDDEN" >/dev/null; then
    strip_comments "$f" | grep -Ein "$FORBIDDEN" >&2 || true
    fail "forbidden shared-host operation referenced in $f"
  fi
done

grep -F 'runs-on: [self-hosted, linux, x64, sonargate-us-test]' "$CD" >/dev/null \
  || fail "deploy job must require self-hosted, linux, x64, and sonargate-us-test"

if grep -E '^[[:space:]]*runs-on:[[:space:]]*self-hosted[[:space:]]*$' "$CD" >/dev/null; then
  fail "bare self-hosted runs-on can dispatch onto the GeoMix runner"
fi

grep -F 'runs-on: ubuntu-latest' "$CD" >/dev/null \
  || fail "image build must stay on the GitHub-hosted runner"

grep -F 'workflow_dispatch:' "$CD" >/dev/null || fail "CD must stay manual"
if grep -E '^[[:space:]]+(push|pull_request|schedule):[[:space:]]*$' "$CD" >/dev/null; then
  fail "CD must not deploy on push, pull request, or schedule"
fi

grep -F 'bash deploy/sonargate-deploy.sh' "$CD" >/dev/null \
  || fail "deploy job must run deploy/sonargate-deploy.sh"

grep -F 'cancel-in-progress: false' "$CD" >/dev/null \
  || fail "CD must not cancel an in-progress deploy"

if grep -n 'SONARGATE_PORT' "$CD" "$COMPOSE" "$DEPLOY" >&2; then
  fail "host port must stay fixed; do not read SONARGATE_PORT"
fi

grep -F '127.0.0.1:18082:8080' "$COMPOSE" >/dev/null \
  || fail "production compose must publish 127.0.0.1:18082:8080"
grep -F '127.0.0.1:18082' "$DEPLOY" >/dev/null \
  || fail "deploy script must health-check 127.0.0.1:18082"

if grep -nE "^[[:space:]]+-[[:space:]]*['\"]?0\\.0\\.0\\.0:|network_mode:[[:space:]]*host" "$COMPOSE" >&2; then
  fail "production compose must not publish on all interfaces or share the host network"
fi

if grep -nE '^[[:space:]]+(volumes|privileged|network_mode|build):[[:space:]]*' "$COMPOSE" >&2; then
  fail "production compose must not add volumes, a build, or extra privileges"
fi

grep -Eq '^name: sonargate$' "$COMPOSE" \
  || fail "compose project name must be sonargate"

grep -F 'SERVICE="sonargate"' "$DEPLOY" >/dev/null \
  || fail "deploy target must stay the sonargate service"
# The dollar signs below are literal text searched for in the deploy script.
# shellcheck disable=SC2016
grep -F 'compose pull "$SERVICE"' "$DEPLOY" >/dev/null \
  || fail "deploy must pull only the target service"
# shellcheck disable=SC2016
grep -F 'compose up -d --no-deps --no-build "$SERVICE"' "$DEPLOY" >/dev/null \
  || fail "deploy must update only the target service"
grep -F 'PROJECT="sonargate"' "$DEPLOY" >/dev/null \
  || fail "deploy must set the sonargate compose project"
# shellcheck disable=SC2016
grep -F 'docker compose -p "$PROJECT"' "$DEPLOY" >/dev/null \
  || fail "deploy must pass the compose project explicitly"

python3 - "$COMPOSE" <<'PY'
import sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()
try:
    import yaml
except ImportError:
    yaml = None

if yaml is not None:
    doc = yaml.safe_load(text)
    if doc.get("name") != "sonargate":
        sys.exit("compose project name must be sonargate")
    services = doc.get("services") or {}
    if list(services) != ["sonargate"]:
        sys.exit("compose must contain only the sonargate service")
    service = services["sonargate"]
    if service.get("ports") != ["127.0.0.1:18082:8080"]:
        sys.exit("compose host binding must be exactly 127.0.0.1:18082:8080")
    for forbidden in ("build", "volumes", "privileged", "network_mode"):
        if forbidden in service:
            sys.exit(f"compose must not set {forbidden}")
    if service.get("container_name") != "sonargate":
        sys.exit("container_name must stay sonargate")
else:
    required = [
        "name: sonargate\n",
        "container_name: sonargate\n",
        "      - '127.0.0.1:18082:8080'\n",
    ]
    for snippet in required:
        if snippet not in text:
            sys.exit(f"missing exact compose snippet: {snippet.strip()}")
print("compose structure ok")
PY

echo "CD shared-host safety checks passed."
