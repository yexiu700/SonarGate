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

# Behavioral checks for previous-image validation & rollback tag resolution.
(
  # shellcheck source=deploy/sonargate-deploy.sh
  source "$DEPLOY"

  TEST_REPO="ghcr.io/yexiu700/sonargate"
  TEST_DIGEST="sha256:e554d8d12cb20de27185e9e8bc7ba862225b558ed26b6aec6dcfbbf082577bd9"
  TEST_ID="sha256:88e2c2cd674f1a340da3ca8eff848890e8b4583537ddf81f94e5a2f45559465e"
  TEST_TARGET="${TEST_REPO}:sha-b2ed2e5"

  # 1. Digest-only reference (live us-test container format)
  parse_prev_image_ref "$TEST_REPO" "${TEST_REPO}@${TEST_DIGEST}" \
    || fail "must accept valid @sha256 digest reference"
  [ "$PREV_KIND" = "digest" ] || fail "expected PREV_KIND=digest, got '$PREV_KIND'"
  resolve_rollback_target "$TEST_REPO" "$TEST_TARGET" "${TEST_REPO}@${TEST_DIGEST}" "$TEST_ID"
  [ "$ROLLBACK_TAG" = "rollback-e554d8d12cb2" ] \
    || fail "expected rollback tag rollback-e554d8d12cb2, got '$ROLLBACK_TAG'"
  [ "$ROLLBACK_IMAGE" = "${TEST_REPO}:rollback-e554d8d12cb2" ] \
    || fail "unexpected ROLLBACK_IMAGE '$ROLLBACK_IMAGE'"

  # 2. Tag-only reference (distinct from target)
  parse_prev_image_ref "$TEST_REPO" "${TEST_REPO}:sha-1111111" \
    || fail "must accept valid tag reference"
  [ "$PREV_KIND" = "tag" ] || fail "expected PREV_KIND=tag, got '$PREV_KIND'"
  resolve_rollback_target "$TEST_REPO" "$TEST_TARGET" "${TEST_REPO}:sha-1111111" "$TEST_ID"
  [ "$ROLLBACK_TAG" = "sha-1111111" ] || fail "expected ROLLBACK_TAG=sha-1111111, got '$ROLLBACK_TAG'"
  [ "$ROLLBACK_IMAGE" = "${TEST_REPO}:sha-1111111" ] \
    || fail "unexpected tag ROLLBACK_IMAGE '$ROLLBACK_IMAGE'"

  # 3. Tag + digest reference (pins local digest tag without moving floating tag)
  parse_prev_image_ref "$TEST_REPO" "${TEST_REPO}:latest@${TEST_DIGEST}" \
    || fail "must accept valid tag@sha256 reference"
  [ "$PREV_KIND" = "tag+digest" ] || fail "expected PREV_KIND=tag+digest, got '$PREV_KIND'"
  resolve_rollback_target "$TEST_REPO" "$TEST_TARGET" "${TEST_REPO}:latest@${TEST_DIGEST}" "$TEST_ID"
  [ "$ROLLBACK_TAG" = "rollback-e554d8d12cb2" ] \
    || fail "expected digest rollback tag for tag+digest, got '$ROLLBACK_TAG'"

  # 4. Floating :latest redeployed onto :latest pins previous image id
  parse_prev_image_ref "$TEST_REPO" "${TEST_REPO}:latest" \
    || fail "must accept :latest tag reference"
  resolve_rollback_target "$TEST_REPO" "${TEST_REPO}:latest" "${TEST_REPO}:latest" "$TEST_ID"
  [ "$ROLLBACK_TAG" = "rollback-88e2c2cd674f" ] \
    || fail "expected image-id rollback tag for :latest redeploy, got '$ROLLBACK_TAG'"

  # 5. Same immutable sha tag redeploy skips redundant rollback tag
  parse_prev_image_ref "$TEST_REPO" "$TEST_TARGET" \
    || fail "must accept target sha tag"
  resolve_rollback_target "$TEST_REPO" "$TEST_TARGET" "$TEST_TARGET" "$TEST_ID"
  [ -z "$ROLLBACK_TAG" ] && [ -z "$ROLLBACK_IMAGE" ] \
    || fail "same immutable tag redeploy should not create rollback tag"

  # 6. Foreign or malformed image references must be rejected
  for bad_ref in \
    "nginx:latest" \
    "ghcr.io/other/sonargate:latest" \
    "ghcr.io/other/sonargate@${TEST_DIGEST}" \
    "ghcr.io/yexiu700/sonargate-other:latest" \
    "${TEST_REPO}@sha256:short" \
    "${TEST_REPO}@sha256:E554D8D12CB20DE27185E9E8BC7BA862225B558ED26B6AEC6DCFBFF082577BD9" \
    "${TEST_REPO}@md5:e554d8d12cb20de27185e9e8bc7ba862" \
    "${TEST_REPO}:../evil" \
    "${TEST_REPO}:latest@${TEST_DIGEST}@extra"; do
    if parse_prev_image_ref "$TEST_REPO" "$bad_ref"; then
      fail "must reject invalid or foreign image reference: $bad_ref"
    fi
  done
)

echo "CD shared-host safety checks passed."
