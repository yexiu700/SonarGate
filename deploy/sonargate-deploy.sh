#!/usr/bin/env bash
# Deploy only the SonarGate service on the shared us-test host.
#
# This script may recreate the sonargate container. It must not clean unused
# Docker data, delete other projects' images, volumes, networks, or containers,
# write host web-server config, reload services outside this container, or run
# migrations. /opt/sonargate/.env and the previously running image are kept.
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/opt/sonargate}"
PUBLIC_COLLECT_URL="${PUBLIC_COLLECT_URL:-}"
REQUIRE_READY_ON_DEPLOY="${REQUIRE_READY_ON_DEPLOY:-false}"
BIND_ADDR="127.0.0.1:18082"
COMPOSE_FILE="docker-compose.prod.yml"
PROJECT="sonargate"
SERVICE="sonargate"
TAG_REGEX='^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
DIGEST_REGEX='^sha256:[0-9a-f]{64}$'

PREV_KIND=""
PREV_TAG=""
PREV_DIGEST=""
ROLLBACK_TAG=""
ROLLBACK_IMAGE=""

# Validate that prev_image belongs to repo and matches one of:
#   - <repo>:<tag>
#   - <repo>@sha256:<64-lowercase-hex>
#   - <repo>:<tag>@sha256:<64-lowercase-hex>
parse_prev_image_ref() {
  local repo="$1"
  local prev_image="$2"
  local rest=""
  local candidate_tag=""
  local candidate_digest=""

  PREV_KIND=""
  PREV_TAG=""
  PREV_DIGEST=""

  case "$prev_image" in
    "${repo}@"*)
      candidate_digest="${prev_image#"${repo}@"}"
      if printf '%s' "$candidate_digest" | grep -Eq "$DIGEST_REGEX"; then
        PREV_KIND="digest"
        PREV_DIGEST="$candidate_digest"
        return 0
      fi
      ;;
    "${repo}:"*)
      rest="${prev_image#"${repo}:"}"
      case "$rest" in
        *@*)
          candidate_tag="${rest%%@*}"
          candidate_digest="${rest#*@}"
          if printf '%s' "$candidate_tag" | grep -Eq "$TAG_REGEX" \
            && printf '%s' "$candidate_digest" | grep -Eq "$DIGEST_REGEX"; then
            PREV_KIND="tag+digest"
            PREV_TAG="$candidate_tag"
            PREV_DIGEST="$candidate_digest"
            return 0
          fi
          ;;
        *)
          if printf '%s' "$rest" | grep -Eq "$TAG_REGEX"; then
            PREV_KIND="tag"
            PREV_TAG="$rest"
            return 0
          fi
          ;;
      esac
      ;;
  esac

  return 1
}

# Derive a safe local repo:tag target for pinning PREV_IMAGE_ID and rolling back
# via docker-compose.prod.yml (which interpolates ${IMAGE_TAG}).
# Digest-pinned containers cannot be passed to `docker tag` as `@sha256:...` or
# rendered through `${IMAGE_TAG}`, so they get a deterministic local rollback tag.
resolve_rollback_target() {
  local repo="$1"
  local target_image="$2"
  local prev_image="$3"
  local prev_image_id="$4"
  local hex=""

  ROLLBACK_TAG=""
  ROLLBACK_IMAGE=""

  if [ -z "$prev_image" ]; then
    return 0
  fi

  case "$PREV_KIND" in
    tag)
      if [ "$prev_image" != "$target_image" ]; then
        ROLLBACK_TAG="$PREV_TAG"
      elif [ "$PREV_TAG" = "latest" ] && printf '%s' "$prev_image_id" | grep -Eq "$DIGEST_REGEX"; then
        hex="${prev_image_id#sha256:}"
        ROLLBACK_TAG="rollback-${hex:0:12}"
      fi
      ;;
    digest|tag+digest)
      hex="${PREV_DIGEST#sha256:}"
      ROLLBACK_TAG="rollback-${hex:0:12}"
      ;;
  esac

  if [ -n "$ROLLBACK_TAG" ] && [ "${repo}:${ROLLBACK_TAG}" != "$target_image" ]; then
    ROLLBACK_IMAGE="${repo}:${ROLLBACK_TAG}"
  else
    ROLLBACK_TAG=""
    ROLLBACK_IMAGE=""
  fi
}

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

rollback() {
  local actual_rollback=""

  if [ -z "$ROLLBACK_TAG" ] || [ -z "$ROLLBACK_IMAGE" ] || [ "$ROLLBACK_IMAGE" = "$TARGET_IMAGE" ]; then
    echo "No distinct previous image available for rollback."
    return 0
  fi
  if ! printf '%s' "$ROLLBACK_TAG" | grep -Eq "$TAG_REGEX"; then
    echo "Previous image was not deleted, but its rollback tag cannot be passed to compose safely."
    return 0
  fi
  actual_rollback="$(IMAGE_TAG="$ROLLBACK_TAG" compose config --images)"
  if [ "$actual_rollback" != "$ROLLBACK_IMAGE" ]; then
    echo "Refusing to roll back: rendered image does not match the rollback tag. Previous image was not deleted."
    return 0
  fi
  if ! docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1; then
    echo "Refusing to roll back: pinned local image ${ROLLBACK_IMAGE} is missing. Previous image was not deleted."
    return 0
  fi
  echo "Rolling back only ${SERVICE} to ${ROLLBACK_IMAGE} (previous ref: ${PREV_IMAGE})."
  IMAGE_TAG="$ROLLBACK_TAG" compose up -d --no-deps --no-build "$SERVICE" || true
}

main() {
  if [ "$DEPLOY_PATH" != "/opt/sonargate" ]; then
    echo "ERROR: refusing to deploy outside /opt/sonargate (got ${DEPLOY_PATH})."
    exit 1
  fi

  if [ -z "${GHCR_OWNER:-}" ] || [ -z "${IMAGE_TAG:-}" ]; then
    echo "ERROR: GHCR_OWNER and IMAGE_TAG are required."
    exit 1
  fi

  if ! printf '%s' "$GHCR_OWNER" | grep -Eq '^[a-z0-9]+([._-][a-z0-9]+)*$'; then
    echo "ERROR: GHCR_OWNER contains unexpected characters."
    exit 1
  fi

  if ! printf '%s' "$IMAGE_TAG" | grep -Eq "$TAG_REGEX"; then
    echo "ERROR: IMAGE_TAG contains unexpected characters."
    exit 1
  fi

  if [ -z "${GHCR_USERNAME:-}" ] || [ -z "${GHCR_TOKEN:-}" ]; then
    echo "ERROR: registry credentials are not set."
    exit 1
  fi

  REPO="ghcr.io/${GHCR_OWNER}/sonargate"
  TARGET_IMAGE="${REPO}:${IMAGE_TAG}"
  echo "Deploying ${TARGET_IMAGE} into ${DEPLOY_PATH} (bind ${BIND_ADDR})"

  if ! grep -F "${BIND_ADDR}:8080" "$COMPOSE_FILE" >/dev/null; then
    echo "ERROR: ${COMPOSE_FILE} must publish ${BIND_ADDR}:8080. Refusing to deploy."
    exit 1
  fi

  if [ ! -f "${DEPLOY_PATH}/.env" ]; then
    echo "ERROR: ${DEPLOY_PATH}/.env not found. Create it with mode 600 before deploying."
    exit 1
  fi

  PREV_IMAGE="$(docker inspect --format='{{.Config.Image}}' "$SERVICE" 2>/dev/null || true)"
  PREV_IMAGE_ID="$(docker inspect --format='{{.Image}}' "$SERVICE" 2>/dev/null || true)"
  echo "Previous image (kept for rollback): ${PREV_IMAGE:-<none>} id=${PREV_IMAGE_ID:-<none>}"

  # Read-only guard: never replace a container that is not this SonarGate image
  # (accepting tag, @sha256 digest, or tag@sha256 digest references), and do not
  # write the deploy directory until that is verified.
  if [ -n "$PREV_IMAGE" ]; then
    if ! parse_prev_image_ref "$REPO" "$PREV_IMAGE"; then
      echo "ERROR: container ${SERVICE} is ${PREV_IMAGE}, outside valid ${REPO} tag/digest formats. Refusing to replace it."
      exit 1
    fi
    resolve_rollback_target "$REPO" "$TARGET_IMAGE" "$PREV_IMAGE" "$PREV_IMAGE_ID"
  fi

  mkdir -p "$DEPLOY_PATH"
  DEST="${DEPLOY_PATH}/${COMPOSE_FILE}"
  if [ -L "$DEST" ]; then
    echo "ERROR: ${DEST} is a symlink. Refusing to write through it."
    exit 1
  fi
  cp "$COMPOSE_FILE" "$DEST"

  cd "$DEPLOY_PATH"

  export GHCR_OWNER IMAGE_TAG

  SERVICES="$(compose config --services)"
  if [ "$SERVICES" != "$SERVICE" ]; then
    echo "ERROR: refusing to deploy; compose services must be exactly ${SERVICE}."
    exit 1
  fi

  IMAGES="$(compose config --images)"
  if [ "$IMAGES" != "$TARGET_IMAGE" ]; then
    echo "ERROR: refusing to pull an unexpected image list."
    exit 1
  fi

  # Pin only this repo's rollback tag to the image id already in use, before pull,
  # so rollback stays local even when the running container used a digest reference.
  # This does not delete images.
  if [ -n "$ROLLBACK_IMAGE" ] && [ "$ROLLBACK_IMAGE" != "$TARGET_IMAGE" ]; then
    if [ -z "$PREV_IMAGE_ID" ]; then
      echo "ERROR: running ${SERVICE} image id is empty. Refusing to replace it."
      exit 1
    fi
    echo "Pinning local rollback tag ${ROLLBACK_IMAGE} to the running image id."
    docker tag "$PREV_IMAGE_ID" "$ROLLBACK_IMAGE"
  fi

  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
  unset GHCR_TOKEN

  compose pull "$SERVICE"

  if ! compose up -d --no-deps --no-build "$SERVICE"; then
    echo "Service update failed."
    rollback
    exit 1
  fi

  GATE_OK=1

  PUBLISHED="$(docker port "$SERVICE" 8080 2>/dev/null || true)"
  PUBLISHED="$(printf '%s' "$PUBLISHED" | tr -d '\r')"
  if [ "$PUBLISHED" != "$BIND_ADDR" ]; then
    echo "GATE FAILED: ${SERVICE} is published as '${PUBLISHED:-<none>}', required ${BIND_ADDR}."
    GATE_OK=0
  fi

  if [ "$GATE_OK" = "1" ]; then
    echo "Checking local liveness: http://${BIND_ADDR}/health ..."
    HEALTH_OK=0
    attempt=1
    while [ "$attempt" -le 30 ]; do
      STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "http://${BIND_ADDR}/health" || echo 000)"
      if [ "$STATUS" = "200" ]; then
        HEALTH_OK=1
        break
      fi
      attempt=$((attempt + 1))
      sleep 1
    done
    if [ "$HEALTH_OK" != "1" ]; then
      echo "GATE FAILED: GET /health did not return 200 within 30s"
      GATE_OK=0
    else
      echo "GET /health -> 200 OK"
    fi
  fi

  if [ "$GATE_OK" = "1" ]; then
    echo "Checking local readiness: http://${BIND_ADDR}/ready ..."
    READY_BODY="$(mktemp)"
    READY_STATUS="$(curl -sS -o "$READY_BODY" -w '%{http_code}' "http://${BIND_ADDR}/ready" || echo 000)"
    echo "GET /ready -> HTTP ${READY_STATUS}: $(cat "$READY_BODY")"
    rm -f "$READY_BODY"
    if [ "$REQUIRE_READY_ON_DEPLOY" = "true" ] && [ "$READY_STATUS" != "200" ]; then
      echo "GATE FAILED: REQUIRE_READY_ON_DEPLOY=true but /ready returned ${READY_STATUS}"
      GATE_OK=0
    fi
  fi

  if [ "$GATE_OK" = "1" ] && [ -n "$PUBLIC_COLLECT_URL" ]; then
    echo "Checking public endpoint (no redirect allowed): ${PUBLIC_COLLECT_URL} ..."
    PUB_STATUS="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$PUBLIC_COLLECT_URL" || echo 000)"
    echo "POST ${PUBLIC_COLLECT_URL} (no auth, no redirects) -> HTTP ${PUB_STATUS}"
    case "$PUB_STATUS" in
      301|302|307|308)
        echo "GATE FAILED: public endpoint returned redirect HTTP ${PUB_STATUS}; GeoMix will fail with redirect_refused!"
        GATE_OK=0
        ;;
      401)
        echo "Public endpoint verified: direct HTTPS with auth active (HTTP 401, no redirects)."
        ;;
      *)
        echo "GATE FAILED: expected HTTP 401 from unauthenticated public /v1/collect, got ${PUB_STATUS}"
        GATE_OK=0
        ;;
    esac
  fi

  if [ "$GATE_OK" != "1" ]; then
    echo "=== Recent ${SERVICE} container logs ==="
    docker logs --tail 100 "$SERVICE" || true
    rollback
    exit 1
  fi

  if [ -n "$PREV_IMAGE_ID" ] && ! docker image inspect "$PREV_IMAGE_ID" >/dev/null 2>&1; then
    echo "ERROR: ${SERVICE} is updated, but the previous image ${PREV_IMAGE_ID} is no longer present."
    exit 1
  fi

  echo "Deployment succeeded: ${TARGET_IMAGE}"
  echo "Rollback image retained: ${ROLLBACK_IMAGE:-${PREV_IMAGE:-<none>}} (previous=${PREV_IMAGE:-<none>} id=${PREV_IMAGE_ID:-<none>})"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
