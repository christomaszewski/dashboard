#!/usr/bin/env bash
# Build + push the dashboard's images to the fleet registry. `rig build` runs this (rigging.yaml
# build.command) POSITIONALLY as:  tools/build-images.sh <registry> [tag]  (tag defaults to arm64).
# Build NATIVELY on arm64 (the binary compiles from source).
#
#   tools/build-images.sh <registry> [tag]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${1:?usage: build-images.sh <registry> [tag]}"
TAG="${2:-arm64}"

# dashboard-zenoh: the standalone remote-api sidecar (zenoh-bridge-remote-api), built from source.
docker build -f "$REPO/deploy/Dockerfile.zenoh-remote-api" -t "$REGISTRY/dashboard-zenoh:$TAG" "$REPO/deploy"
docker push "$REGISTRY/dashboard-zenoh:$TAG"

# dashboard-web: the React bundle baked into Caddy (multi-stage; Node only in the build stage). Build
# context is the repo ROOT (Dockerfile.web needs app/ + deploy/Caddyfile).
docker build -f "$REPO/deploy/Dockerfile.web" -t "$REGISTRY/dashboard-web:$TAG" "$REPO"
docker push "$REGISTRY/dashboard-web:$TAG"

# dashboard-rig-agent: the optional rig agent (python + docker cli; agent/ from the repo root).
docker build -f "$REPO/deploy/Dockerfile.rig-agent" -t "$REGISTRY/dashboard-rig-agent:$TAG" "$REPO"
docker push "$REGISTRY/dashboard-rig-agent:$TAG"

echo "build-images: pushed $REGISTRY/dashboard-zenoh:$TAG, $REGISTRY/dashboard-web:$TAG and $REGISTRY/dashboard-rig-agent:$TAG" >&2
