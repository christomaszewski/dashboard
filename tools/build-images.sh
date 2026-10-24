#!/usr/bin/env bash
# Build + push the dashboard's images to the fleet registry. `rig build` runs this (rigging.yaml
# build.command) POSITIONALLY as:  tools/build-images.sh <registry> [tag]  (tag defaults to arm64).
# Rig requests native arm64/amd64 members via RIG_BUILD_PLATFORMS; standalone defaults to the host.
#
#   tools/build-images.sh <registry> [tag]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${1:?usage: build-images.sh <registry> [tag]}"
TAG="${2:-arm64}"
. "$REPO/tools/rig-build.sh"

# dashboard-zenoh: the standalone remote-api sidecar (zenoh-bridge-remote-api), built from source.
rig_build "$REGISTRY/dashboard-zenoh:$TAG" -f "$REPO/deploy/Dockerfile.zenoh-remote-api" "$REPO/deploy"

# dashboard-web: the React bundle baked into Caddy (multi-stage; Node only in the build stage). Build
# context is the repo ROOT (Dockerfile.web needs app/ + deploy/Caddyfile).
rig_build "$REGISTRY/dashboard-web:$TAG" -f "$REPO/deploy/Dockerfile.web" "$REPO"

# dashboard-rig-agent: the optional rig agent (python + docker cli; agent/ from the repo root).
rig_build "$REGISTRY/dashboard-rig-agent:$TAG" -f "$REPO/deploy/Dockerfile.rig-agent" "$REPO"

# dashboard-state: the optional vehicle-state service (Node bundle of app/src/vstate; repo root).
rig_build "$REGISTRY/dashboard-state:$TAG" -f "$REPO/deploy/Dockerfile.state" "$REPO"

echo "build-images: pushed $REGISTRY/dashboard-zenoh:$TAG, $REGISTRY/dashboard-web:$TAG, $REGISTRY/dashboard-rig-agent:$TAG and $REGISTRY/dashboard-state:$TAG" >&2
