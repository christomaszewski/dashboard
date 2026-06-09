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

# TODO(dashboard-web): once the Vite bundle + deploy/Dockerfile.web exist, build+push the baked
# Caddy+bundle image here, e.g.:
#   docker build -f "$REPO/deploy/Dockerfile.web" -t "$REGISTRY/dashboard-web:$TAG" "$REPO"
#   docker push "$REGISTRY/dashboard-web:$TAG"
# Until then dashboard-web runs stock caddy:2-alpine with the bundle bind-mounted (see compose).

echo "build-images: pushed $REGISTRY/dashboard-zenoh:$TAG  (dashboard-web TODO: needs the frontend bundle)" >&2
