#!/usr/bin/env bash
# radio_link.sh — simulate the operator's radio hop between a browser and the vehicle's public sidecar.
#
# A "radio" is a small container relaying one laptop port to the sidecar's WebSocket through a
# shaped interface (Linux netem). Point a browser or tools/test_vehicle_state_link.mjs at the radio's
# port instead of the sidecar's; the vehicle side (router, state bridge, dashboard-state) stays clean.
#
#   tools/radio_link.sh up     <name> <laptop-port> <sidecar-port>   start a radio
#   tools/radio_link.sh set    <name> <netem args...>   e.g. delay 150ms 30ms loss 5% rate 400kbit
#   tools/radio_link.sh clear  <name>                    a clean link
#   tools/radio_link.sh outage <name> <seconds>          drop every packet, then restore the profile
#   tools/radio_link.sh flap   <name> <up-s> <down-s> <cycles>   repeated outages
#   tools/radio_link.sh show   <name>
#   tools/radio_link.sh down   <name>
#
# netem shapes the relay container's egress, which carries both directions of the hop (downlink to the
# browser, uplink to the sidecar), so the round trip is about twice `delay`. The relay terminates TCP,
# so loss is retransmitted on each side of it, as on a real link. Bench only: Docker with
# NET_ADMIN on the relay; the sidecar must be reachable from a bridge-network container at the
# Docker host's gateway (host networking, as dash-up runs it).
set -euo pipefail
IMAGE=dashboard-radio-link:local
cmd="${1:?usage: radio_link.sh up|set|clear|outage|flap|show|down <name> ...}"
name="dashboard-radio-${2:?radio name}"; shift 2

netem() { docker exec "$name" tc "$@"; }
current() {   # the netem arguments now applied, without kernel-added fields
  netem qdisc show dev eth0 | awk '/netem/{sub(/.*refcnt [0-9]+ /, ""); sub(/limit [0-9]+ /, ""); sub(/ seed [0-9]+/, ""); print}'
}

case "$cmd" in
  up)
    laptop="${1:?laptop port}"; sidecar="${2:?sidecar port}"
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      docker build -q -t "$IMAGE" - >/dev/null <<'EOF'
FROM alpine:3.22
RUN apk add --no-cache iproute2-tc socat
ENTRYPOINT ["/bin/sh", "-c", "GW=$(ip route | awk '/default/{print $3}'); exec socat TCP-LISTEN:${LISTEN},fork,reuseaddr,nodelay TCP:${TARGET_HOST:-$GW}:${TARGET},nodelay"]
EOF
    fi
    docker run -d --rm --name "$name" --cap-add NET_ADMIN -p "127.0.0.1:$laptop:$laptop" \
      -e LISTEN="$laptop" -e TARGET="$sidecar" "$IMAGE" >/dev/null
    echo "radio ${name#dashboard-radio-}: localhost:$laptop -> sidecar :$sidecar" ;;
  set)
    netem qdisc replace dev eth0 root netem "$@"
    echo "radio ${name#dashboard-radio-}: $(current)" ;;
  clear)
    netem qdisc del dev eth0 root 2>/dev/null || true
    echo "radio ${name#dashboard-radio-}: clean" ;;
  outage)
    prev="$(current)"
    netem qdisc replace dev eth0 root netem loss 100%
    sleep "${1:?seconds}"
    if [ -n "$prev" ]; then netem qdisc replace dev eth0 root netem $prev; else netem qdisc del dev eth0 root; fi ;;
  flap)
    for _ in $(seq "${3:?cycles}"); do sleep "${1:?up seconds}"; "$0" outage "${name#dashboard-radio-}" "${2:?down seconds}"; done ;;
  show)
    netem qdisc show dev eth0 ;;
  down)
    docker rm -f "$name" >/dev/null 2>&1 || true ;;
  *)
    echo "radio_link.sh: unknown command $cmd" >&2; exit 2 ;;
esac
