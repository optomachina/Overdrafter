#!/usr/bin/env bash
set -euo pipefail

# Privileged, provider-free proof for the OVD-420 recovery egress boundary.
# It creates an isolated Linux namespace and synthetic TLS origin only; it
# never resolves or contacts a production hostname.

readonly NETWORK_SUBNET='172.28.42.0/29'
readonly NETWORK_GATEWAY='172.28.42.1'
readonly SYNTHETIC_ORIGIN='93.184.216.34'
readonly LOOPBACK_REBIND_ORIGIN='127.0.0.2'
readonly RFC1918_REBIND_ORIGIN='10.0.0.2'
readonly METADATA_REBIND_ORIGIN='169.254.169.254'
readonly ALTERNATE_PUBLIC_REBIND_ORIGIN='93.184.216.35'
readonly APPROVED_HOST='approved.recovery.test'
readonly UNKNOWN_HOST='unknown.recovery.test'
readonly UNKNOWN_SUBDOMAIN='sub.approved.recovery.test'
readonly ALTERNATE_RESOLVER='1.1.1.1'
readonly BRIDGE='ovd420-egress0'
readonly NAMESPACE='ovd420-proof-client'
readonly HOST_VETH='ovd420p-host'
readonly CLIENT_VETH='ovd420p-client'
readonly INPUT_CHAIN='OVD420_PROOF_IN'
readonly FORWARD_CHAIN='OVD420_PROOF_FWD'
readonly CONTROL_SCRIPT='scripts/ovd420-recovery-egress-control.sh'

work_dir=''
dns_pid=''
resolver_pid=''
haproxy_pid=''
origin_pid=''
bridge_created=''
namespace_created=''
input_chain_created=''
forward_chain_created=''

fail() {
  local failure_code="$1"
  printf '%s\n' "OVD-420 recovery egress proof failed: $failure_code" >&2
  if [[ -n "$work_dir" ]]; then
    local log_path
    for log_path in "$work_dir"/*.log; do
      [[ -f "$log_path" ]] || continue
      printf '%s\n' "--- $(basename "$log_path") ---" >&2
      tail -n 30 "$log_path" >&2
    done
  fi
  exit 1
}

cleanup() {
  set +e
  [[ -n "$haproxy_pid" ]] && kill "$haproxy_pid" 2>/dev/null
  [[ -n "$dns_pid" ]] && kill "$dns_pid" 2>/dev/null
  [[ -n "$resolver_pid" ]] && kill "$resolver_pid" 2>/dev/null
  [[ -n "$origin_pid" ]] && kill "$origin_pid" 2>/dev/null
  if [[ -n "$input_chain_created" ]]; then
    iptables -D INPUT -i "$BRIDGE" -j "$INPUT_CHAIN" 2>/dev/null
    iptables -F "$INPUT_CHAIN" 2>/dev/null
    iptables -X "$INPUT_CHAIN" 2>/dev/null
  fi
  if [[ -n "$forward_chain_created" ]]; then
    iptables -D FORWARD -i "$BRIDGE" -j "$FORWARD_CHAIN" 2>/dev/null
    iptables -F "$FORWARD_CHAIN" 2>/dev/null
    iptables -X "$FORWARD_CHAIN" 2>/dev/null
  fi
  [[ -n "$namespace_created" ]] && ip netns del "$NAMESPACE" 2>/dev/null
  [[ -n "$bridge_created" ]] && ip link del "$BRIDGE" 2>/dev/null
  [[ -n "$work_dir" ]] && rm -rf "$work_dir"
}
trap cleanup EXIT

require_root_and_tools() {
  [[ "$(id -u)" -eq 0 ]] || fail 'root_required'
  local tool
  for tool in basename dig dnsmasq haproxy id ip iptables jq openssl setpriv ss sysctl tail timeout; do
    command -v "$tool" >/dev/null 2>&1 || fail "missing_$tool"
  done
}

must_fail() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "unexpected_success_$label"
  fi
}

client() {
  ip netns exec "$NAMESPACE" "$@"
}

write_resolver_config() {
  local address="$1"
  cat >"$work_dir/resolver.conf" <<EOF
no-resolv
no-hosts
bind-interfaces
listen-address=127.0.0.1
port=5353
address=/$APPROVED_HOST/$address
EOF
  chmod 0644 "$work_dir/resolver.conf"
}

write_synthetic_fixtures() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -subj "/CN=$APPROVED_HOST" \
    -keyout "$work_dir/origin.key" \
    -out "$work_dir/origin.crt" >/dev/null 2>&1

  printf '%s' '{"version":1,"hostnames":["approved.recovery.test"]}' >"$work_dir/policy.json"
  chmod 0755 "$work_dir"
  chmod 0644 "$work_dir/origin.crt" "$work_dir/policy.json"
  write_resolver_config "$SYNTHETIC_ORIGIN"
}

setup_isolated_network() {
  ip link show "$BRIDGE" >/dev/null 2>&1 && fail 'bridge_already_exists'
  ip netns list | awk '{print $1}' | grep -Fxq "$NAMESPACE" && fail 'namespace_already_exists'
  ip link add "$BRIDGE" type bridge
  bridge_created='1'
  ip addr add "$NETWORK_GATEWAY/29" dev "$BRIDGE"
  ip addr add "$SYNTHETIC_ORIGIN/32" dev "$BRIDGE"
  ip link set "$BRIDGE" up
  ip netns add "$NAMESPACE"
  namespace_created='1'
  ip link add "$HOST_VETH" type veth peer name "$CLIENT_VETH"
  ip link set "$HOST_VETH" master "$BRIDGE"
  ip link set "$HOST_VETH" up
  ip link set "$CLIENT_VETH" netns "$NAMESPACE"
  client ip link set lo up
  client ip addr add 172.28.42.2/29 dev "$CLIENT_VETH"
  client ip link set "$CLIENT_VETH" up
  client ip route add default via "$NETWORK_GATEWAY"
  client sysctl -q -w net.ipv6.conf.all.disable_ipv6=1

  iptables -N "$INPUT_CHAIN"
  input_chain_created='1'
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p udp --dport 53 -j ACCEPT
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p tcp --dport 53 -j ACCEPT
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p tcp --dport 443 -j ACCEPT
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -j REJECT
  iptables -I INPUT 1 -i "$BRIDGE" -j "$INPUT_CHAIN"
  iptables -N "$FORWARD_CHAIN"
  forward_chain_created='1'
  iptables -A "$FORWARD_CHAIN" -s "$NETWORK_SUBNET" -j REJECT
  iptables -I FORWARD 1 -i "$BRIDGE" -j "$FORWARD_CHAIN"
}

start_controlled_resolver() {
  local dnsmasq_uid dnsmasq_gid
  id dnsmasq >/dev/null 2>&1 || fail 'dnsmasq_user_missing'
  dnsmasq_uid="$(id -u dnsmasq)"
  dnsmasq_gid="$(id -g dnsmasq)"
  setpriv --reuid="$dnsmasq_uid" --regid="$dnsmasq_gid" --clear-groups -- \
    dnsmasq --keep-in-foreground --conf-file="$work_dir/resolver.conf" >"$work_dir/resolver.log" 2>&1 &
  resolver_pid="$!"
  local attempts=0
  until ss -H -lnu | awk '$4 == "127.0.0.1:5353" { found = 1 } END { exit found ? 0 : 1 }'; do
    attempts=$((attempts + 1))
    (( attempts < 20 )) || fail 'synthetic_resolver_not_listening'
    sleep 0.1
  done
}

render_synthetic_control() {
  OVD420_RECOVERY_EGRESS_TEST_RENDER=1 \
    bash "$CONTROL_SCRIPT" test-resolve \
      "$work_dir/policy.json" "$work_dir/addresses.json" 127.0.0.1 5353
  OVD420_RECOVERY_EGRESS_TEST_RENDER=1 \
    bash "$CONTROL_SCRIPT" test-render \
      "$work_dir/policy.json" "$work_dir/addresses.json" \
      "$work_dir/dnsmasq.conf" "$work_dir/haproxy.cfg"
  chmod 0644 "$work_dir/addresses.json" "$work_dir/dnsmasq.conf" "$work_dir/haproxy.cfg"
  grep -Fqx "  server upstream_0 $SYNTHETIC_ORIGIN:443" "$work_dir/haproxy.cfg" || fail 'pinned_backend_not_rendered'
  ! grep -Fq 'resolvers controlled_dns' "$work_dir/haproxy.cfg" || fail 'runtime_resolver_rendered'
}

start_synthetic_services() {
  local dnsmasq_uid dnsmasq_gid haproxy_uid haproxy_gid
  openssl s_server -quiet -accept "$SYNTHETIC_ORIGIN:443" \
    -cert "$work_dir/origin.crt" -key "$work_dir/origin.key" >"$work_dir/origin.log" 2>&1 &
  origin_pid="$!"
  id dnsmasq >/dev/null 2>&1 || fail 'dnsmasq_user_missing'
  id haproxy >/dev/null 2>&1 || fail 'haproxy_user_missing'
  dnsmasq_uid="$(id -u dnsmasq)"
  dnsmasq_gid="$(id -g dnsmasq)"
  haproxy_uid="$(id -u haproxy)"
  haproxy_gid="$(id -g haproxy)"
  setpriv --reuid="$dnsmasq_uid" --regid="$dnsmasq_gid" --clear-groups \
    --inh-caps +net_bind_service --ambient-caps +net_bind_service -- \
    dnsmasq --keep-in-foreground --conf-file="$work_dir/dnsmasq.conf" >"$work_dir/dns.log" 2>&1 &
  dns_pid="$!"
  (
    cd "$work_dir"
    exec setpriv --reuid="$haproxy_uid" --regid="$haproxy_gid" --clear-groups \
      --inh-caps +net_bind_service --ambient-caps +net_bind_service -- \
      haproxy -f "$work_dir/haproxy.cfg"
  ) >"$work_dir/haproxy.log" 2>&1 &
  haproxy_pid="$!"

  local attempts=0
  until ss -H -lnt | awk -v endpoint="$SYNTHETIC_ORIGIN:443" '$4 == endpoint { found = 1 } END { exit found ? 0 : 1 }' && \
    ss -H -lnt | awk -v endpoint="$NETWORK_GATEWAY:443" '$4 == endpoint { found = 1 } END { exit found ? 0 : 1 }' && \
    ss -H -lnu | awk -v endpoint="$NETWORK_GATEWAY:53" '$4 == endpoint { found = 1 } END { exit found ? 0 : 1 }' && \
    ss -H -lnu | awk '$4 == "127.0.0.1:5353" { found = 1 } END { exit found ? 0 : 1 }'; do
    attempts=$((attempts + 1))
    (( attempts < 20 )) || fail 'synthetic_services_not_listening'
    sleep 0.1
  done
}

prove_allow_and_deny_paths() {
  [[ "$(client dig +short "@$NETWORK_GATEWAY" "$APPROVED_HOST" A)" == "$NETWORK_GATEWAY" ]] || fail 'approved_dns_not_gateway_bound'
  [[ -z "$(client dig +short "@$NETWORK_GATEWAY" "$UNKNOWN_HOST" A)" ]] || fail 'unknown_dns_resolved'
  [[ -z "$(client dig +short "@$NETWORK_GATEWAY" "$UNKNOWN_SUBDOMAIN" A)" ]] || fail 'unknown_subdomain_resolved'

  client sh -c "printf '\\n' | timeout 3 openssl s_client -connect $NETWORK_GATEWAY:443 -servername $APPROVED_HOST -verify_hostname $APPROVED_HOST -verify_return_error -CAfile $work_dir/origin.crt -brief" >/dev/null 2>&1 || fail 'approved_sni_rejected'
  must_fail 'wrong_sni' client sh -c "printf '\\n' | timeout 3 openssl s_client -connect $NETWORK_GATEWAY:443 -servername $UNKNOWN_HOST -brief"
  must_fail 'unknown_subdomain_sni' client sh -c "printf '\\n' | timeout 3 openssl s_client -connect $NETWORK_GATEWAY:443 -servername $UNKNOWN_SUBDOMAIN -brief"
  must_fail 'missing_sni' client sh -c "printf '\\n' | timeout 3 openssl s_client -connect $NETWORK_GATEWAY:443 -noservername -brief"

  must_fail 'direct_public_ipv4' client timeout 2 bash -c "exec 3<>/dev/tcp/$SYNTHETIC_ORIGIN/443"
  must_fail 'private_raw_ip' client timeout 2 bash -c 'exec 3<>/dev/tcp/10.0.0.1/443'
  must_fail 'link_local_raw_ip' client timeout 2 bash -c 'exec 3<>/dev/tcp/169.254.1.1/443'
  must_fail 'metadata_ip' client timeout 2 bash -c 'exec 3<>/dev/tcp/169.254.169.254/80'
  must_fail 'metadata_token_path' client timeout 2 bash -c \
    'exec 3<>/dev/tcp/169.254.169.254/80; printf "GET /computeMetadata/v1/instance/service-accounts/default/token HTTP/1.0\r\nMetadata-Flavor: Google\r\n\r\n" >&3; cat <&3'
  must_fail 'alternate_dns_udp' client dig "@$ALTERNATE_RESOLVER" +time=1 +tries=1 "$APPROVED_HOST" A
  must_fail 'alternate_dns_tcp' client dig +tcp "@$ALTERNATE_RESOLVER" +time=1 +tries=1 "$APPROVED_HOST" A
  must_fail 'alternate_gateway_dns' client dig "@$NETWORK_GATEWAY" -p 54 +time=1 +tries=1 "$APPROVED_HOST" A
  must_fail 'doh_tcp_443' client timeout 2 bash -c "exec 3<>/dev/tcp/$ALTERNATE_RESOLVER/443"
  must_fail 'dot_tcp_853' client timeout 2 bash -c "exec 3<>/dev/tcp/$ALTERNATE_RESOLVER/853"
  must_fail 'quic_udp_443' client dig "@$ALTERNATE_RESOLVER" -p 443 +time=1 +tries=1 "$APPROVED_HOST" A
  must_fail 'ipv6_route' client ip -6 route get 2001:4860:4860::8888
  [[ "$(client cat /proc/sys/net/ipv6/conf/all/disable_ipv6)" == '1' ]] || fail 'ipv6_not_disabled'
}

prove_post_readiness_rebinds_are_pinned() {
  local label address
  while IFS=':' read -r label address; do
    kill "$resolver_pid"
    wait "$resolver_pid" 2>/dev/null || true
    resolver_pid=''
    write_resolver_config "$address"
    start_controlled_resolver

    must_fail "${label}_rebind_readiness" env OVD420_RECOVERY_EGRESS_TEST_RENDER=1 \
      bash "$CONTROL_SCRIPT" test-resolution-match \
        "$work_dir/policy.json" "$work_dir/addresses.json" 127.0.0.1 5353
    must_fail "${label}_direct_destination" client timeout 2 bash -c \
      "exec 3<>/dev/tcp/$address/443"
    client sh -c "printf '\\n' | timeout 3 openssl s_client -connect $NETWORK_GATEWAY:443 -servername $APPROVED_HOST -verify_hostname $APPROVED_HOST -verify_return_error -CAfile $work_dir/origin.crt -brief" >/dev/null 2>&1 || fail "pinned_backend_changed_after_${label}_rebind"
    grep -Fqx "  server upstream_0 $SYNTHETIC_ORIGIN:443" "$work_dir/haproxy.cfg" || fail 'pinned_backend_drifted'
    ! grep -Fq "$address" "$work_dir/haproxy.cfg" || fail "${label}_rebind_rendered"
  done <<EOF
loopback:$LOOPBACK_REBIND_ORIGIN
rfc1918:$RFC1918_REBIND_ORIGIN
metadata:$METADATA_REBIND_ORIGIN
alternate_public:$ALTERNATE_PUBLIC_REBIND_ORIGIN
EOF
}

require_root_and_tools
work_dir="$(mktemp -d)"
write_synthetic_fixtures
setup_isolated_network
start_controlled_resolver
render_synthetic_control
start_synthetic_services
prove_allow_and_deny_paths
prove_post_readiness_rebinds_are_pinned
printf '%s\n' 'OVD-420 recovery egress network proof passed.'
