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
# 4. Firewalls the per-build INTEGRATION networks (SHP-REQ-119, SHP-REQ-123). Each integration run
#    gets its own `internal: true` compose network with a /24 from 172.30.0.0/16 on a bridge named
#    shp-it-<n>, and Shipyard asks Docker to give the host no address on it (gateway mode
#    `isolated`). Belt and braces, for an engine where the host does own an address there: chain
#    SHIPYARD-ITEST-INPUT, jumped to from INPUT for anything arriving on a shp-it-* bridge or from a
#    source in the pool, accepts replies to connections the host opened and DROPs everything else;
#    chain SHIPYARD-ITEST, jumped to from DOCKER-USER the same way, lets traffic between containers
#    of one integration network through to Docker's own rules and DROPs everything else. Refuses
#    when a Docker network or a route that is not Shipyard's already overlaps the pool — keep
#    172.30.0.0/16 out of Docker's default-address-pools (daemon.json) so none is ever made there.
# 5. If ip6tables has a DOCKER-USER chain, drops all IPv6 forwarded from these bridges as well
#    (the networks have no IPv6 address to begin with).
#
# Requires Docker's iptables firewall backend (the default); with `firewall-backend: nftables`
# there is no DOCKER-USER chain and this script refuses rather than guessing.
#
# The constants below are mirrored in packages/sequence/src/build/network.ts; change both together.
# The build network's subnet is overridable via the environment for a host where it collides with
# something real; the integration pool is not (the agent allocates from the constant).

set -eu

NETWORK="${SHIPYARD_BUILD_NETWORK:-shipyard-build}"
SUBNET="${SHIPYARD_BUILD_SUBNET:-172.31.254.0/24}"
GATEWAY="${SHIPYARD_BUILD_GATEWAY:-172.31.254.1}"
BRIDGE="${SHIPYARD_BUILD_BRIDGE:-br-shipyard-bld}"
FORWARD_CHAIN="SHIPYARD-BUILD"
INPUT_CHAIN="SHIPYARD-BUILD-INPUT"
# RFC1918, link-local (cloud metadata), CGNAT (tailnets), loopback, "this network", multicast, reserved.
BLOCKED="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4"
# Per-build integration networks: the pool the agent allocates /24s from, and their bridge prefix.
ITEST_POOL="172.30.0.0/16"
ITEST_BRIDGE_PREFIX="shp-it-"
ITEST_FORWARD_CHAIN="SHIPYARD-ITEST"
ITEST_INPUT_CHAIN="SHIPYARD-ITEST-INPUT"

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

# ── 4. per-build integration networks ─────────────────────────────────────────────────────────────
ITEST_IF="${ITEST_BRIDGE_PREFIX}+"

# a.b.c.d -> integer
ip2int() {
  echo "$1" | awk -F. '{ printf "%.0f", (($1 * 256 + $2) * 256 + $3) * 256 + $4 }'
}
# overlaps CIDR_A CIDR_B: true when the two IPv4 ranges share an address.
overlaps() {
  a_ip="${1%/*}"; a_len="${1#*/}"; b_ip="${2%/*}"; b_len="${2#*/}"
  [ "$a_ip" = "$1" ] && a_len=32
  [ "$b_ip" = "$2" ] && b_len=32
  len=$a_len; [ "$b_len" -lt "$len" ] && len=$b_len
  size=$((1 << (32 - len)))
  [ $(($(ip2int "$a_ip") / size)) -eq $(($(ip2int "$b_ip") / size)) ]
}

# Nothing that is not Shipyard's may live in the pool: the source-address rules would cut it off.
for net in $(docker network ls -q); do
  line="$(docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$net")"
  name="${line%% *}"
  case "$name" in shipyard-build-*) continue ;; esac
  for subnet in ${line#* }; do
    case "$subnet" in *:*) continue ;; esac
    overlaps "$subnet" "$ITEST_POOL" &&
      die "Docker network $name ($subnet) overlaps the integration pool $ITEST_POOL; move it (and keep $ITEST_POOL out of daemon.json default-address-pools), then rerun"
  done
done
if command -v ip >/dev/null 2>&1; then
  ip -4 route show | while read -r dest rest; do
    case "$dest" in default) continue ;; esac
    case "$rest" in *"dev $ITEST_BRIDGE_PREFIX"*) continue ;; esac
    if overlaps "$dest" "$ITEST_POOL"; then
      echo "build-network: route $dest $rest overlaps the integration pool $ITEST_POOL" >&2
      exit 1
    fi
  done || die "a host route overlaps the integration pool $ITEST_POOL; free it, then rerun"
fi

iptables -N "$ITEST_FORWARD_CHAIN" 2>/dev/null || true
iptables -F "$ITEST_FORWARD_CHAIN"
iptables -A "$ITEST_FORWARD_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# Container to container on one integration bridge (seen here when br_netfilter is loaded): leave it
# to Docker's own internal-network rules, which already drop anything that leaves the subnet.
iptables -A "$ITEST_FORWARD_CHAIN" -i "$ITEST_IF" -o "$ITEST_IF" -s "$ITEST_POOL" -d "$ITEST_POOL" -j RETURN
iptables -A "$ITEST_FORWARD_CHAIN" -j DROP
iptables -C DOCKER-USER -s "$ITEST_POOL" -j "$ITEST_FORWARD_CHAIN" 2>/dev/null ||
  iptables -I DOCKER-USER 1 -s "$ITEST_POOL" -j "$ITEST_FORWARD_CHAIN"
iptables -C DOCKER-USER -i "$ITEST_IF" -j "$ITEST_FORWARD_CHAIN" 2>/dev/null ||
  iptables -I DOCKER-USER 1 -i "$ITEST_IF" -j "$ITEST_FORWARD_CHAIN"

iptables -N "$ITEST_INPUT_CHAIN" 2>/dev/null || true
iptables -F "$ITEST_INPUT_CHAIN"
iptables -A "$ITEST_INPUT_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A "$ITEST_INPUT_CHAIN" -j DROP
iptables -C INPUT -s "$ITEST_POOL" -j "$ITEST_INPUT_CHAIN" 2>/dev/null ||
  iptables -I INPUT 1 -s "$ITEST_POOL" -j "$ITEST_INPUT_CHAIN"
iptables -C INPUT -i "$ITEST_IF" -j "$ITEST_INPUT_CHAIN" 2>/dev/null ||
  iptables -I INPUT 1 -i "$ITEST_IF" -j "$ITEST_INPUT_CHAIN"

# ── 5. IPv6, belt and braces ─────────────────────────────────────────────────────────────────────
if command -v ip6tables >/dev/null 2>&1 && ip6tables -n -L DOCKER-USER >/dev/null 2>&1; then
  for iface in "$BRIDGE" "$ITEST_IF"; do
    ip6tables -C DOCKER-USER -i "$iface" -j DROP 2>/dev/null ||
      ip6tables -I DOCKER-USER 1 -i "$iface" -j DROP
    ip6tables -C INPUT -i "$iface" -j DROP 2>/dev/null ||
      ip6tables -I INPUT 1 -i "$iface" -j DROP
  done
fi

echo "build-network: rules installed — from $BRIDGE: dropped to $BLOCKED $GATEWAY${HOST_GW:+ $HOST_GW} and to the host; public internet allowed"
echo "build-network: rules installed — from $ITEST_POOL / $ITEST_IF: dropped to the host and off the per-build network"
