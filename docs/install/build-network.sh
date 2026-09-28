#!/bin/sh
# Shipyard build network (SHP-T-7.8, SHP-REQ-123, SHP-REQ-124).
#
# Run ONCE as root on the Docker host, by the operator — never by the agent — before the first
# Shipyard build, and again after every host reboot (iptables rules do not survive one; the Docker
# network does). Idempotent: running it twice leaves exactly one copy of every rule.
#
#   sudo sh docs/install/build-network.sh
#
# What it does:
#
# 1. Creates the Docker bridge network `shipyard-build` with a fixed IPv4 subnet, IPv6 off, and a
#    fixed bridge interface name, `br-shipyard-bld`. Rootless buildkitd (buildkit.compose.yml) is
#    the only thing attached to it; a Dockerfile RUN step runs in buildkitd's network namespace, so
#    what buildkitd can reach is exactly what a build step can reach.
# 2. Installs chain SHIPYARD-BUILD, jumped to from DOCKER-USER for every packet ARRIVING FROM that
#    bridge (matched by interface, not by source address, so a spoofed source changes nothing):
#    DROP to every private, link-local, CGNAT/tailnet, loopback, multicast and reserved range, to the
#    network's own gateway, and to the host's default-route gateway. Everything else RETURNs to
#    Docker's own rules — i.e. the public internet stays reachable, for package registries.
#    (RETURN rather than ACCEPT: an ACCEPT in DOCKER-USER would skip Docker's own isolation rules.)
# 3. Installs chain SHIPYARD-BUILD-INPUT, jumped to from INPUT for every packet from that bridge
#    addressed to the host ITSELF (any of its addresses — traffic to the host never passes
#    DOCKER-USER): accept replies to connections the host opened, DROP everything else. This is what
#    keeps a build step off the Docker daemon, SSH, and anything else listening on the host.
# 4. If ip6tables has a DOCKER-USER chain, drops all IPv6 forwarded from the bridge as well (the
#    network has no IPv6 address to begin with).
#
# Requires Docker's iptables firewall backend (the default); with `firewall-backend: nftables`
# there is no DOCKER-USER chain and this script refuses rather than guessing.
#
# The constants below are mirrored in packages/sequence/src/build/network.ts; change both together.
# Overridable via the environment for a host where the subnet collides with something real.

set -eu

NETWORK="${SHIPYARD_BUILD_NETWORK:-shipyard-build}"
SUBNET="${SHIPYARD_BUILD_SUBNET:-172.31.254.0/24}"
GATEWAY="${SHIPYARD_BUILD_GATEWAY:-172.31.254.1}"
BRIDGE="${SHIPYARD_BUILD_BRIDGE:-br-shipyard-bld}"
FORWARD_CHAIN="SHIPYARD-BUILD"
INPUT_CHAIN="SHIPYARD-BUILD-INPUT"
# RFC1918, link-local (cloud metadata), CGNAT (tailnets), loopback, "this network", multicast, reserved.
BLOCKED="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4"

die() {
  echo "build-network: $*" >&2
  exit 1
}

[ "$(id -u)" = "0" ] || die "must run as root (it installs iptables rules)"
command -v docker >/dev/null 2>&1 || die "docker CLI not found"
command -v iptables >/dev/null 2>&1 || die "iptables not found"

# ── 1. the network ─────────────────────────────────────────────────────────────────────────────
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  have="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}|{{index .Options "com.docker.network.bridge.name"}}|{{.EnableIPv6}}|{{.Internal}}' "$NETWORK")"
  want="$SUBNET |$BRIDGE|false|false"
  [ "$have" = "$want" ] || die "network $NETWORK exists but is not the one this script makes (have '$have', want '$want'); remove it (docker network rm $NETWORK) after stopping buildkitd, then rerun"
  echo "build-network: network $NETWORK already present"
else
  docker network create \
    --driver bridge \
    --subnet "$SUBNET" \
    --gateway "$GATEWAY" \
    --ipv6=false \
    --opt "com.docker.network.bridge.name=$BRIDGE" \
    --opt "com.docker.network.bridge.enable_icc=false" \
    --label "dev.d3cloud.shipyard.role=build-network" \
    "$NETWORK" >/dev/null
  echo "build-network: created network $NETWORK ($SUBNET on $BRIDGE)"
fi

# ── 2. forwarded traffic from the bridge ──────────────────────────────────────────────────────────
iptables -n -L DOCKER-USER >/dev/null 2>&1 ||
  die "no DOCKER-USER chain in iptables: start Docker first, with its iptables firewall backend"

HOST_GW=""
if command -v ip >/dev/null 2>&1; then
  HOST_GW="$(ip -4 route show default 2>/dev/null | awk '$1 == "default" { print $3; exit }')"
fi

iptables -N "$FORWARD_CHAIN" 2>/dev/null || true
iptables -F "$FORWARD_CHAIN"
iptables -A "$FORWARD_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for cidr in $BLOCKED "$GATEWAY" $HOST_GW; do
  iptables -A "$FORWARD_CHAIN" -d "$cidr" -j DROP
done
iptables -A "$FORWARD_CHAIN" -j RETURN
iptables -C DOCKER-USER -i "$BRIDGE" -j "$FORWARD_CHAIN" 2>/dev/null ||
  iptables -I DOCKER-USER 1 -i "$BRIDGE" -j "$FORWARD_CHAIN"

# ── 3. traffic from the bridge to the host itself ────────────────────────────────────────────────
iptables -N "$INPUT_CHAIN" 2>/dev/null || true
iptables -F "$INPUT_CHAIN"
iptables -A "$INPUT_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A "$INPUT_CHAIN" -j DROP
iptables -C INPUT -i "$BRIDGE" -j "$INPUT_CHAIN" 2>/dev/null ||
  iptables -I INPUT 1 -i "$BRIDGE" -j "$INPUT_CHAIN"

# ── 4. IPv6, belt and braces ─────────────────────────────────────────────────────────────────────
if command -v ip6tables >/dev/null 2>&1 && ip6tables -n -L DOCKER-USER >/dev/null 2>&1; then
  ip6tables -C DOCKER-USER -i "$BRIDGE" -j DROP 2>/dev/null ||
    ip6tables -I DOCKER-USER 1 -i "$BRIDGE" -j DROP
  ip6tables -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null ||
    ip6tables -I INPUT 1 -i "$BRIDGE" -j DROP
fi

echo "build-network: rules installed — from $BRIDGE: dropped to $BLOCKED $GATEWAY${HOST_GW:+ $HOST_GW} and to the host; public internet allowed"
