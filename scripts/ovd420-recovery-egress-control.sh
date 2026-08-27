#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly CONTRACT_ID='ovd420-recovery-egress-v1'
readonly POLICY_VERSION='1'
readonly NETWORK_NAME='ovd420-recovery-egress'
readonly NETWORK_SUBNET='172.28.42.0/29'
readonly NETWORK_GATEWAY='172.28.42.1'
readonly NETWORK_BRIDGE='ovd420-egress0'
readonly DNS_SERVICE='ovd420-dns.service'
readonly GATEWAY_SERVICE='ovd420-haproxy.service'
readonly DNS_UNIT_PATH="/etc/systemd/system/$DNS_SERVICE"
readonly GATEWAY_UNIT_PATH="/etc/systemd/system/$GATEWAY_SERVICE"
readonly DNS_EXECUTABLE='/usr/sbin/dnsmasq'
readonly GATEWAY_EXECUTABLE='/usr/sbin/haproxy'
readonly POLICY_DIR='/etc/overdrafter'
readonly POLICY_PATH="$POLICY_DIR/ovd420-recovery-egress-policy.json"
readonly ADDRESS_MAP_PATH="$POLICY_DIR/ovd420-recovery-egress-addresses.json"
readonly DNSMASQ_CONFIG="$POLICY_DIR/ovd420-dnsmasq.conf"
readonly HAPROXY_CONFIG="$POLICY_DIR/ovd420-haproxy.cfg"
readonly STATE_DIR='/run/ovd420-recovery-egress'
readonly DIGEST_PATH="$STATE_DIR/policy.sha256"
readonly EVIDENCE_PATH="$STATE_DIR/evidence.json"
readonly INSTALL_PHASE_PATH='/run/ovd420-recovery-egress-install-phase'
readonly CONTROLLED_RESOLVER='169.254.169.254'
readonly CONTROLLED_RESOLVER_PORT='53'
readonly MAX_ADDRESSES_PER_HOST='32'
readonly MAX_CNAME_DEPTH='8'
readonly POLICY_HOSTNAMES_FILTER='.hostnames[]'
readonly INPUT_CHAIN='OVD420_IN'
readonly FORWARD_CHAIN='OVD420_FWD'
readonly WORKER_IMAGE_PATTERN='^us-west1-docker\.pkg\.dev/overdrafter-worker-9133/cloud-run-source-deploy/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$'

fail() {
  local failure_code="$1"
  printf '%s\n' "OVD-420 recovery egress control failed: $failure_code" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || fail 'root_required'
}

require_commands() {
  local command_name
  for command_name in "$@"; do
    command -v "$command_name" >/dev/null 2>&1 || fail 'runtime_dependency_missing'
  done
}

write_install_phase() {
  local phase="$1" temporary_phase
  case "$phase" in
    dependencies|policy|resolution|network|configuration|firewall|services|verification) ;;
    *) fail 'install_phase_invalid' ;;
  esac
  temporary_phase="$(mktemp "${INSTALL_PHASE_PATH}.tmp.XXXXXX")"
  printf '%s\n' "$phase" >"$temporary_phase"
  chown root:root "$temporary_phase"
  chmod 0600 "$temporary_phase"
  mv -fT -- "$temporary_phase" "$INSTALL_PHASE_PATH"
}

canonicalize_policy() {
  local source_path="$1"
  [[ -f "$source_path" && ! -L "$source_path" ]] || fail 'policy_missing'
  jq -e --argjson version "$POLICY_VERSION" '
    type == "object" and
    (keys | sort) == ["hostnames", "version"] and
    .version == $version and
    (.hostnames | type == "array" and length > 0 and length <= 32) and
    (.hostnames | all(
      type == "string" and
      length > 0 and
      length <= 253 and
      (explode | all(. < 128)) and
      test("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$"; "i") and
      (test("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$") | not) and
      (contains("*") | not) and
      (contains("/") | not) and
      (endswith(".") | not) and
      (split(".") | all(startswith("xn--") | not))
    )) and
    ((.hostnames | map(ascii_downcase) | unique | length) == (.hostnames | length))
  ' "$source_path" >/dev/null || fail 'policy_invalid'

  jq -c '{version, hostnames: (.hostnames | map(ascii_downcase) | sort)}' "$source_path"
}

policy_digest() {
  local policy_path="$1"
  sha256sum "$policy_path" | awk '{print $1}'
}

hostname_is_approved() {
  local candidate="$1" policy_path="${2:-$POLICY_PATH}"
  jq -e --arg candidate "$candidate" '.hostnames | index($candidate) != null' \
    "$policy_path" >/dev/null
}

public_ipv4() {
  local address="$1"
  local first second third fourth
  IFS='.' read -r first second third fourth <<<"$address"
  [[ "$first" =~ ^(0|[1-9][0-9]*)$ && "$second" =~ ^(0|[1-9][0-9]*)$ && "$third" =~ ^(0|[1-9][0-9]*)$ && "$fourth" =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  (( first <= 255 && second <= 255 && third <= 255 && fourth <= 255 )) || return 1
  (( first != 0 && first != 10 && first != 127 && first < 224 )) || return 1
  ! (( first == 100 && second >= 64 && second <= 127 )) || return 1
  ! (( first == 169 && second == 254 )) || return 1
  ! (( first == 172 && second >= 16 && second <= 31 )) || return 1
  ! (( first == 192 && second == 0 && third == 0 )) || return 1
  ! (( first == 192 && second == 0 && third == 2 )) || return 1
  ! (( first == 192 && second == 168 )) || return 1
  ! (( first == 198 && (second == 18 || second == 19) )) || return 1
  ! (( first == 198 && second == 51 && third == 100 )) || return 1
  ! (( first == 203 && second == 0 && third == 113 )) || return 1
}

canonicalize_dns_alias_name() {
  local candidate="${1%.}"
  jq -enr --arg candidate "$candidate" '
    ($candidate | ascii_downcase) as $name |
    select(
      ($name | length) > 0 and
      ($name | length) <= 253 and
      ($name | test("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")) and
      ($name | test("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$") | not) and
      ($name | split(".") | all(startswith("xn--") | not))
    ) |
    $name
  '
}

resolve_address_map() {
  local policy_path="$1" output_path="$2"
  local resolver_host="${3:-$CONTROLLED_RESOLVER}" resolver_port="${4:-$CONTROLLED_RESOLVER_PORT}"
  local hostname answers answer_name answer_ttl answer_class answer_type answer_value
  local expected_name canonical_answer_name canonical_answer_value seen_name cname_target
  local cname_depth record_count record_index matched_count used_record_count
  local addresses_json entries='[]'
  local -a addresses cname_chain record_names record_types record_values
  while IFS= read -r hostname; do
    addresses=()
    cname_chain=("$hostname")
    record_names=()
    record_types=()
    record_values=()
    cname_depth=0
    expected_name="$hostname"
    answers="$(
      dig +time=2 +tries=1 +noall +answer \
        "@$resolver_host" -p "$resolver_port" \
        "$hostname" A 2>/dev/null
    )" || fail 'dns_resolution_unavailable'
    [[ -n "$answers" ]] || fail 'dns_resolution_unavailable'
    while read -r answer_name answer_ttl answer_class answer_type answer_value extra; do
      [[ -n "$answer_name" && -z "${extra:-}" ]] || fail 'dns_answer_invalid'
      [[ "$answer_ttl" =~ ^[0-9]+$ && "$answer_class" == 'IN' ]] || fail 'dns_answer_invalid'
      canonical_answer_name="$(canonicalize_dns_alias_name "$answer_name")" || fail 'dns_answer_name_invalid'
      if [[ "$answer_type" == 'CNAME' ]]; then
        canonical_answer_value="$(canonicalize_dns_alias_name "$answer_value")" || fail 'dns_cname_invalid'
      elif [[ "$answer_type" == 'A' ]]; then
        public_ipv4 "$answer_value" || fail 'dns_address_not_public'
        canonical_answer_value="$answer_value"
      else
        fail 'dns_answer_type_invalid'
      fi
      record_names+=("$canonical_answer_name")
      record_types+=("$answer_type")
      record_values+=("$canonical_answer_value")
    done <<<"$answers"

    record_count="${#record_names[@]}"
    used_record_count=0
    while true; do
      addresses=()
      cname_target=''
      matched_count=0
      for ((record_index = 0; record_index < record_count; record_index += 1)); do
        [[ "${record_names[$record_index]}" == "$expected_name" ]] || continue
        matched_count=$((matched_count + 1))
        if [[ "${record_types[$record_index]}" == 'CNAME' ]]; then
          [[ -z "$cname_target" && ${#addresses[@]} -eq 0 ]] || fail 'dns_answer_chain_invalid'
          cname_target="${record_values[$record_index]}"
        else
          [[ -z "$cname_target" ]] || fail 'dns_answer_chain_invalid'
          addresses+=("${record_values[$record_index]}")
        fi
      done
      (( matched_count > 0 )) || fail 'dns_answer_chain_invalid'
      used_record_count=$((used_record_count + matched_count))
      if [[ -z "$cname_target" ]]; then
        break
      fi
      cname_depth=$((cname_depth + 1))
      (( cname_depth <= MAX_CNAME_DEPTH )) || fail 'dns_cname_chain_too_deep'
      for seen_name in "${cname_chain[@]}"; do
        [[ "$cname_target" != "$seen_name" ]] || fail 'dns_cname_loop'
      done
      cname_chain+=("$cname_target")
      expected_name="$cname_target"
    done
    (( used_record_count == record_count )) || fail 'dns_answer_chain_invalid'
    (( ${#addresses[@]} > 0 )) || fail 'dns_resolution_unavailable'
    addresses_json="$(printf '%s\n' "${addresses[@]}" | jq -Rsc '
      split("\n") | map(select(length > 0)) | unique | sort
    ')"
    (( $(jq 'length' <<<"$addresses_json") <= MAX_ADDRESSES_PER_HOST )) || fail 'dns_address_set_too_large'
    entries="$(jq -cn \
      --argjson entries "$entries" \
      --arg hostname "$hostname" \
      --argjson addresses "$addresses_json" \
      '$entries + [{hostname: $hostname, addresses: $addresses}]')"
  done < <(jq -r "$POLICY_HOSTNAMES_FILTER" "$policy_path")
  printf '%s' "$(jq -cn --argjson hosts "$entries" '{version: 1, hosts: $hosts}')" >"$output_path"
}

canonicalize_address_map() {
  local source_path="$1" policy_path="${2:-$POLICY_PATH}"
  local policy_hostnames hostname address canonical
  [[ -f "$source_path" && ! -L "$source_path" ]] || fail 'address_map_missing'
  policy_hostnames="$(jq -c '.hostnames' "$policy_path")"
  jq -e \
    --argjson version "$POLICY_VERSION" \
    --argjson max_addresses "$MAX_ADDRESSES_PER_HOST" \
    --argjson policy_hostnames "$policy_hostnames" '
      type == "object" and
      (keys | sort) == ["hosts", "version"] and
      .version == $version and
      (.hosts | type == "array" and length == ($policy_hostnames | length)) and
      ([.hosts[].hostname] == $policy_hostnames) and
      (.hosts | all(
        type == "object" and
        (keys | sort) == ["addresses", "hostname"] and
        (.hostname | type == "string") and
        (.addresses | type == "array" and length > 0 and length <= $max_addresses) and
        (.addresses | all(type == "string" and test("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$"))) and
        (.addresses == (.addresses | unique | sort))
      ))
    ' "$source_path" >/dev/null || fail 'address_map_invalid'
  while IFS=$'\t' read -r hostname address; do
    hostname_is_approved "$hostname" "$policy_path" || fail 'address_map_hostname_invalid'
    public_ipv4 "$address" || fail 'address_map_address_not_public'
  done < <(jq -r '.hosts[] | .hostname as $hostname | .addresses[] | [$hostname, .] | @tsv' "$source_path")
  canonical="$(jq -c '{version, hosts: [.hosts[] | {hostname, addresses}]}' "$source_path")"
  printf '%s' "$canonical"
}

address_map_matches_controlled_resolution() {
  local policy_path="${1:-$POLICY_PATH}" address_map_path="${2:-$ADDRESS_MAP_PATH}"
  local resolver_host="${3:-$CONTROLLED_RESOLVER}" resolver_port="${4:-$CONTROLLED_RESOLVER_PORT}"
  local fresh_map canonical_map
  fresh_map="$(mktemp)"
  resolve_address_map "$policy_path" "$fresh_map" "$resolver_host" "$resolver_port"
  canonical_map="$(canonicalize_address_map "$address_map_path" "$policy_path")"
  # Exact equality is deliberate: DNS drift requires OVD-410 requalification.
  if [[ "$canonical_map" != "$(<"$address_map_path")" ]] || ! cmp -s "$fresh_map" "$address_map_path"; then
    rm -f "$fresh_map"
    return 1
  fi
  rm -f "$fresh_map"
}

verify_gateway_resolution() {
  local hostname answers
  while IFS= read -r hostname; do
    answers="$(dig +time=2 +tries=1 +short "@$NETWORK_GATEWAY" "$hostname" A 2>/dev/null)"
    [[ "$answers" == "$NETWORK_GATEWAY" ]] || fail 'gateway_dns_mapping_invalid'
  done < <(jq -r "$POLICY_HOSTNAMES_FILTER" "$POLICY_PATH")
  answers="$(dig +time=2 +tries=1 +short "@$NETWORK_GATEWAY" 'ovd420-unknown.invalid' A 2>/dev/null)"
  [[ -z "$answers" ]] || fail 'gateway_dns_unknown_resolved'
}

render_dnsmasq_config() {
  local output_path="$1" policy_path="${2:-$POLICY_PATH}"
  local hostname
  {
    printf '%s\n' \
      'no-resolv' \
      'no-hosts' \
      'no-poll' \
      'domain-needed' \
      'bogus-priv' \
      'stop-dns-rebind' \
      'bind-interfaces' \
      "interface=$NETWORK_BRIDGE" \
      "listen-address=$NETWORK_GATEWAY" \
      'port=53' \
      'cache-size=0' \
      'no-negcache'
    while IFS= read -r hostname; do
      printf 'host-record=%s,%s\n' "$hostname" "$NETWORK_GATEWAY"
    done < <(jq -r "$POLICY_HOSTNAMES_FILTER" "$policy_path")
  } >"$output_path"
}

render_haproxy_config() {
  local output_path="$1" policy_path="${2:-$POLICY_PATH}" address_map_path="${3:-$ADDRESS_MAP_PATH}"
  local hostname address index=0 address_index
  {
    printf '%s\n' \
      'global' \
      '  maxconn 64' \
      '' \
      'defaults' \
      '  mode tcp' \
      '  timeout connect 10s' \
      '  timeout client 60s' \
      '  timeout server 60s' \
      '' \
      'frontend recovery_tls' \
      "  bind $NETWORK_GATEWAY:443" \
      '  mode tcp' \
      '  tcp-request inspect-delay 5s' \
      '  acl tls_client_hello req.ssl_hello_type 1'
    while IFS= read -r hostname; do
      printf '  acl approved_sni_%d req.ssl_sni -i %s\n' "$index" "$hostname"
      index=$((index + 1))
    done < <(jq -r "$POLICY_HOSTNAMES_FILTER" "$policy_path")
    index=0
    while IFS= read -r hostname; do
      printf '  tcp-request content accept if tls_client_hello approved_sni_%d\n' "$index"
      index=$((index + 1))
    done < <(jq -r "$POLICY_HOSTNAMES_FILTER" "$policy_path")
    printf '%s\n' \
      '  tcp-request content reject if tls_client_hello' \
      '  tcp-request content reject if WAIT_END'
    index=0
    while IFS= read -r hostname; do
      printf '  use_backend approved_host_%d if tls_client_hello approved_sni_%d\n' "$index" "$index"
      index=$((index + 1))
    done < <(jq -r "$POLICY_HOSTNAMES_FILTER" "$policy_path")
    index=0
    while IFS= read -r hostname; do
      printf '\nbackend approved_host_%d\n' "$index"
      printf '  mode tcp\n'
      address_index=0
      while IFS= read -r address; do
        printf '  server upstream_%d %s:443\n' "$address_index" "$address"
        address_index=$((address_index + 1))
      done < <(jq -r --arg hostname "$hostname" '.hosts[] | select(.hostname == $hostname) | .addresses[]' "$address_map_path")
      (( address_index > 0 )) || fail 'address_map_host_missing'
      index=$((index + 1))
    done < <(jq -r "$POLICY_HOSTNAMES_FILTER" "$policy_path")
  } >"$output_path"
}

# Test-only seams exercise address resolution and config rendering without
# weakening the production resolver or filesystem paths.
resolve_test_address_map() {
  local source_policy="$1" address_output="$2" resolver_host="$3" resolver_port="$4" temporary_policy
  [[ "${OVD420_RECOVERY_EGRESS_TEST_RENDER:-}" == '1' ]] || fail 'test_render_not_enabled'
  require_commands dig jq
  temporary_policy="$(mktemp)"
  canonicalize_policy "$source_policy" >"$temporary_policy"
  resolve_address_map "$temporary_policy" "$address_output" "$resolver_host" "$resolver_port"
  canonicalize_address_map "$address_output" "$temporary_policy" >/dev/null
  rm -f "$temporary_policy"
}

render_test_config() {
  local source_policy="$1" source_address_map="$2" dns_output="$3" haproxy_output="$4"
  local temporary_policy temporary_address_map
  [[ "${OVD420_RECOVERY_EGRESS_TEST_RENDER:-}" == '1' ]] || fail 'test_render_not_enabled'
  require_commands jq
  temporary_policy="$(mktemp)"
  temporary_address_map="$(mktemp)"
  canonicalize_policy "$source_policy" >"$temporary_policy"
  canonicalize_address_map "$source_address_map" "$temporary_policy" >"$temporary_address_map"
  render_dnsmasq_config "$dns_output" "$temporary_policy"
  render_haproxy_config "$haproxy_output" "$temporary_policy" "$temporary_address_map"
  rm -f "$temporary_policy" "$temporary_address_map"
}

verify_test_resolution_match() {
  local source_policy="$1" source_address_map="$2" resolver_host="$3" resolver_port="$4"
  [[ "${OVD420_RECOVERY_EGRESS_TEST_RENDER:-}" == '1' ]] || fail 'test_render_not_enabled'
  require_commands jq sha256sum dig cmp
  address_map_matches_controlled_resolution \
    "$source_policy" "$source_address_map" "$resolver_host" "$resolver_port" || \
    fail 'test_address_map_resolution_drift'
}

render_dns_unit() {
  cat <<UNIT
[Unit]
Description=OVD-420 recovery allowlist DNS
Requires=docker.service
After=docker.service

[Service]
Type=simple
User=dnsmasq
Group=dnsmasq
ExecStart=$DNS_EXECUTABLE --keep-in-foreground --conf-file=$DNSMASQ_CONFIG
Restart=no
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateDevices=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_UNIX
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
}

render_gateway_unit() {
  cat <<UNIT
[Unit]
Description=OVD-420 recovery SNI gateway
Requires=$DNS_SERVICE
After=$DNS_SERVICE

[Service]
Type=notify
User=haproxy
Group=haproxy
ExecStart=$GATEWAY_EXECUTABLE -Ws -f $HAPROXY_CONFIG
Restart=no
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateDevices=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_UNIX
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
}

install_units() {
  render_dns_unit | install -o root -g root -m 0644 /dev/stdin "$DNS_UNIT_PATH"
  render_gateway_unit | install -o root -g root -m 0644 /dev/stdin "$GATEWAY_UNIT_PATH"
}

network_matches_contract() {
  docker network inspect "$NETWORK_NAME" 2>/dev/null | jq -e \
    --arg subnet "$NETWORK_SUBNET" \
    --arg gateway "$NETWORK_GATEWAY" \
    --arg bridge "$NETWORK_BRIDGE" '
      length == 1 and
      .[0].Driver == "bridge" and
      .[0].Internal == true and
      .[0].EnableIPv6 == false and
      .[0].IPAM.Config == [{Subnet: $subnet, Gateway: $gateway}] and
      .[0].Options["com.docker.network.bridge.name"] == $bridge
    ' >/dev/null
}

ensure_network() {
  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    network_matches_contract || fail 'network_contract_mismatch'
    return
  fi
  docker network create \
    --driver bridge \
    --internal \
    --subnet "$NETWORK_SUBNET" \
    --gateway "$NETWORK_GATEWAY" \
    --opt "com.docker.network.bridge.name=$NETWORK_BRIDGE" \
    "$NETWORK_NAME" >/dev/null
  network_matches_contract || fail 'network_creation_failed'
}

ensure_ipv6_boundary() {
  sysctl -q -w "net.ipv6.conf.$NETWORK_BRIDGE.disable_ipv6=1"
  sysctl -q -w "net.ipv6.conf.$NETWORK_BRIDGE.accept_ra=0"
  sysctl -q -w "net.ipv6.conf.$NETWORK_BRIDGE.forwarding=0"
  ipv6_boundary_matches_contract || fail 'ipv6_contract_mismatch'
}

ipv6_boundary_matches_contract() {
  [[ "$(sysctl -n "net.ipv6.conf.$NETWORK_BRIDGE.disable_ipv6")" == '1' ]] &&
    [[ "$(sysctl -n "net.ipv6.conf.$NETWORK_BRIDGE.accept_ra")" == '0' ]] &&
    [[ "$(sysctl -n "net.ipv6.conf.$NETWORK_BRIDGE.forwarding")" == '0' ]]
}

ensure_firewall() {
  iptables -N "$INPUT_CHAIN" 2>/dev/null || true
  iptables -F "$INPUT_CHAIN"
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p udp --dport 53 -j ACCEPT
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p tcp --dport 53 -j ACCEPT
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p tcp --dport 443 -j ACCEPT
  iptables -A "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -j REJECT
  iptables -C INPUT -i "$NETWORK_BRIDGE" -j "$INPUT_CHAIN" 2>/dev/null || \
    iptables -I INPUT 1 -i "$NETWORK_BRIDGE" -j "$INPUT_CHAIN"

  iptables -N "$FORWARD_CHAIN" 2>/dev/null || true
  iptables -F "$FORWARD_CHAIN"
  iptables -A "$FORWARD_CHAIN" -s "$NETWORK_SUBNET" -j REJECT
  iptables -C DOCKER-USER -i "$NETWORK_BRIDGE" -j "$FORWARD_CHAIN" 2>/dev/null || \
    iptables -I DOCKER-USER 1 -i "$NETWORK_BRIDGE" -j "$FORWARD_CHAIN"

  while iptables -C DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT 2>/dev/null; do
    iptables -D DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT
  done
  while iptables -C DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT 2>/dev/null; do
    iptables -D DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT
  done
  iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || \
    iptables -A DOCKER-USER -d 169.254.169.254/32 -j REJECT
}

firewall_matches_contract() {
  local first_input_rule first_forward_rule
  local expected_input_rules expected_forward_rules
  first_input_rule="$(iptables -S INPUT | awk '/^-A / { print; exit }')"
  first_forward_rule="$(iptables -S DOCKER-USER | awk '/^-A / { print; exit }')"
  expected_input_rules="$(printf '%s\n' \
    "-N $INPUT_CHAIN" \
    "-A $INPUT_CHAIN -s $NETWORK_SUBNET -d $NETWORK_GATEWAY/32 -p udp -m udp --dport 53 -j ACCEPT" \
    "-A $INPUT_CHAIN -s $NETWORK_SUBNET -d $NETWORK_GATEWAY/32 -p tcp -m tcp --dport 53 -j ACCEPT" \
    "-A $INPUT_CHAIN -s $NETWORK_SUBNET -d $NETWORK_GATEWAY/32 -p tcp -m tcp --dport 443 -j ACCEPT" \
    "-A $INPUT_CHAIN -s $NETWORK_SUBNET -j REJECT --reject-with icmp-port-unreachable")"
  expected_forward_rules="$(printf '%s\n' \
    "-N $FORWARD_CHAIN" \
    "-A $FORWARD_CHAIN -s $NETWORK_SUBNET -j REJECT --reject-with icmp-port-unreachable")"
  [[ "$first_input_rule" == "-A INPUT -i $NETWORK_BRIDGE -j $INPUT_CHAIN" ]] &&
    [[ "$first_forward_rule" == "-A DOCKER-USER -i $NETWORK_BRIDGE -j $FORWARD_CHAIN" ]] &&
    [[ "$(iptables -S "$INPUT_CHAIN")" == "$expected_input_rules" ]] &&
    [[ "$(iptables -S "$FORWARD_CHAIN")" == "$expected_forward_rules" ]] &&
    iptables -C INPUT -i "$NETWORK_BRIDGE" -j "$INPUT_CHAIN" >/dev/null 2>&1 &&
    iptables -C "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p udp --dport 53 -j ACCEPT >/dev/null 2>&1 &&
    iptables -C "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p tcp --dport 53 -j ACCEPT >/dev/null 2>&1 &&
    iptables -C "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -d "$NETWORK_GATEWAY" -p tcp --dport 443 -j ACCEPT >/dev/null 2>&1 &&
    iptables -C "$INPUT_CHAIN" -s "$NETWORK_SUBNET" -j REJECT >/dev/null 2>&1 &&
    iptables -C DOCKER-USER -i "$NETWORK_BRIDGE" -j "$FORWARD_CHAIN" >/dev/null 2>&1 &&
    iptables -C "$FORWARD_CHAIN" -s "$NETWORK_SUBNET" -j REJECT >/dev/null 2>&1 &&
    ! iptables -C DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT >/dev/null 2>&1 &&
    ! iptables -C DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT >/dev/null 2>&1
}

rendered_configs_match() {
  local expected_dns expected_haproxy
  expected_dns="$(mktemp)"
  expected_haproxy="$(mktemp)"
  render_dnsmasq_config "$expected_dns"
  render_haproxy_config "$expected_haproxy" "$POLICY_PATH" "$ADDRESS_MAP_PATH"
  if ! cmp -s "$expected_dns" "$DNSMASQ_CONFIG" || ! cmp -s "$expected_haproxy" "$HAPROXY_CONFIG"; then
    rm -f "$expected_dns" "$expected_haproxy"
    return 1
  fi
  rm -f "$expected_dns" "$expected_haproxy"
}

systemd_property() {
  local unit="$1" property="$2"
  systemctl show "$unit" --property="$property" --value
}

pid_in_unit_cgroup() {
  local pid="$1" control_group="$2"
  [[ -r "/proc/$pid/cgroup" ]] || return 1
  awk -F: -v expected="$control_group" '
    $3 == expected || index($3, expected "/") == 1 { found = 1 }
    END { exit found ? 0 : 1 }
  ' "/proc/$pid/cgroup"
}

unit_matches_contract() {
  local unit="$1" fragment="$2" expected_unit="$3" expected_type="$4"
  local expected_user="$5" expected_group="$6" expected_executable="$7"
  local main_pid control_group expected_executable_path
  [[ -f "$fragment" && ! -L "$fragment" ]] || return 1
  [[ "$(stat -c '%u:%g:%a' -- "$fragment")" == '0:0:644' ]] || return 1
  cmp -s "$expected_unit" "$fragment" || return 1
  [[ "$(systemd_property "$unit" FragmentPath)" == "$fragment" ]] || return 1
  [[ -z "$(systemd_property "$unit" DropInPaths)" ]] || return 1
  [[ "$(systemd_property "$unit" NeedDaemonReload)" == 'no' ]] || return 1
  [[ "$(systemd_property "$unit" LoadState)" == 'loaded' ]] || return 1
  [[ "$(systemd_property "$unit" ActiveState)" == 'active' ]] || return 1
  [[ "$(systemd_property "$unit" SubState)" == 'running' ]] || return 1
  [[ "$(systemd_property "$unit" Type)" == "$expected_type" ]] || return 1
  [[ "$(systemd_property "$unit" User)" == "$expected_user" ]] || return 1
  [[ "$(systemd_property "$unit" Group)" == "$expected_group" ]] || return 1
  control_group="$(systemd_property "$unit" ControlGroup)"
  [[ "$control_group" == "/system.slice/$unit" ]] || return 1
  main_pid="$(systemd_property "$unit" MainPID)"
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  expected_executable_path="$(readlink -f -- "$expected_executable")"
  [[ -n "$expected_executable_path" ]] || return 1
  [[ "$(readlink -f -- "/proc/$main_pid/exe")" == "$expected_executable_path" ]] || return 1
  pid_in_unit_cgroup "$main_pid" "$control_group"
}

units_match_contract() {
  local expected_dns expected_gateway status=0
  expected_dns="$(mktemp)"
  expected_gateway="$(mktemp)"
  render_dns_unit >"$expected_dns"
  render_gateway_unit >"$expected_gateway"
  unit_matches_contract \
    "$DNS_SERVICE" "$DNS_UNIT_PATH" "$expected_dns" simple dnsmasq dnsmasq "$DNS_EXECUTABLE" || status=1
  unit_matches_contract \
    "$GATEWAY_SERVICE" "$GATEWAY_UNIT_PATH" "$expected_gateway" notify haproxy haproxy "$GATEWAY_EXECUTABLE" || status=1
  rm -f "$expected_dns" "$expected_gateway"
  return "$status"
}

listener_owned_by_unit() {
  local protocol="$1" port="$2" unit="$3" expected_executable="$4"
  local endpoint control_group sockets pid expected_executable_path pid_count=0
  endpoint="$NETWORK_GATEWAY:$port"
  control_group="$(systemd_property "$unit" ControlGroup)"
  [[ "$control_group" == "/system.slice/$unit" ]] || return 1
  expected_executable_path="$(readlink -f -- "$expected_executable")"
  [[ -n "$expected_executable_path" ]] || return 1
  if [[ "$protocol" == 'tcp' ]]; then
    sockets="$(ss -H -O -4 -lntp "sport = :$port")" || return 1
  else
    sockets="$(ss -H -O -4 -lnup "sport = :$port")" || return 1
  fi
  sockets="$(awk -v expected="$endpoint" '$4 == expected' <<<"$sockets")"
  [[ -n "$sockets" ]] || return 1
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
    pid_count=$((pid_count + 1))
    pid_in_unit_cgroup "$pid" "$control_group" || return 1
    [[ "$(readlink -f -- "/proc/$pid/exe")" == "$expected_executable_path" ]] || return 1
  done < <(grep -oE 'pid=[0-9]+' <<<"$sockets" | cut -d= -f2 | sort -u)
  (( pid_count > 0 ))
}

network_has_no_containers() {
  docker network inspect "$NETWORK_NAME" | jq -e '.[0].Containers == {}' >/dev/null
}

write_evidence() {
  local digest="$1"
  local hostnames
  hostnames="$(jq -c '.hostnames' "$POLICY_PATH")"
  jq -n \
    --arg schema 'ovd420-recovery-egress-evidence-v1' \
    --arg contract_id "$CONTRACT_ID" \
    --arg digest "$digest" \
    --argjson hostnames "$hostnames" \
    --arg network "$NETWORK_NAME" \
    --arg subnet "$NETWORK_SUBNET" \
    --arg gateway "$NETWORK_GATEWAY" \
    --arg bridge "$NETWORK_BRIDGE" '
      {
        schema: $schema,
        contractId: $contract_id,
        policyDigest: $digest,
        hostnames: $hostnames,
        topology: {network: $network, subnet: $subnet, gateway: $gateway, bridge: $bridge},
        services: {dns: "healthy", gateway: "healthy", browser: "absent"},
        listeners: {
          dnsTcp: {host: $gateway, protocol: "tcp", port: 53},
          dnsUdp: {host: $gateway, protocol: "udp", port: 53},
          tls: {host: $gateway, protocol: "tcp", port: 443}
        },
        firewall: {dockerUserDefaultDeny: true, browserNetworkRestricted: true},
        policyIdentities: {
          classifier: {contractId: $contract_id, digest: $digest},
          fullRecovery: {contractId: $contract_id, digest: $digest}
        }
      }
    ' >"$EVIDENCE_PATH"
  chmod 0600 "$EVIDENCE_PATH"
}

install_control() {
  local source_policy="$1"
  local canonical_policy digest temporary_address_map
  require_root
  write_install_phase dependencies
  require_commands docker jq sha256sum haproxy dnsmasq iptables systemctl ss dig cmp stat readlink grep cut sort cat sysctl
  write_install_phase policy
  canonical_policy="$(canonicalize_policy "$source_policy")"
  install -d -m 0755 "$POLICY_DIR"
  install -d -m 0700 "$STATE_DIR"
  printf '%s' "$canonical_policy" >"$POLICY_PATH"
  chmod 0600 "$POLICY_PATH"
  digest="$(policy_digest "$POLICY_PATH")"
  printf '%s\n' "$digest" >"$DIGEST_PATH"
  chmod 0600 "$DIGEST_PATH"
  write_install_phase resolution
  temporary_address_map="$(mktemp "$POLICY_DIR/.ovd420-addresses.XXXXXX")"
  resolve_address_map "$POLICY_PATH" "$temporary_address_map"
  canonicalize_address_map "$temporary_address_map" "$POLICY_PATH" >/dev/null
  install -o root -g root -m 0600 "$temporary_address_map" "$ADDRESS_MAP_PATH"
  rm -f "$temporary_address_map"
  write_install_phase network
  ensure_network
  ensure_ipv6_boundary
  write_install_phase configuration
  render_dnsmasq_config "$DNSMASQ_CONFIG"
  render_haproxy_config "$HAPROXY_CONFIG" "$POLICY_PATH" "$ADDRESS_MAP_PATH"
  chmod 0644 "$DNSMASQ_CONFIG" "$HAPROXY_CONFIG"
  dnsmasq --test --conf-file="$DNSMASQ_CONFIG" >/dev/null 2>&1 || fail 'dns_config_invalid'
  haproxy -c -f "$HAPROXY_CONFIG" >/dev/null 2>&1 || fail 'gateway_config_invalid'
  install_units
  write_install_phase firewall
  ensure_firewall
  write_install_phase services
  systemctl daemon-reload
  systemctl enable "$DNS_SERVICE" "$GATEWAY_SERVICE" >/dev/null
  systemctl restart "$DNS_SERVICE" "$GATEWAY_SERVICE"
  write_install_phase verification
  verify_control "$digest"
  rm -f "$INSTALL_PHASE_PATH"
}

verify_control() {
  local expected_digest="${1:-}"
  local canonical_policy actual_digest configured_digest
  require_root
  require_commands docker jq sha256sum haproxy dnsmasq iptables systemctl ss dig cmp stat readlink grep cut sort cat sysctl
  [[ -f "$POLICY_PATH" && -f "$ADDRESS_MAP_PATH" && -f "$DIGEST_PATH" ]] || fail 'policy_not_installed'
  canonical_policy="$(canonicalize_policy "$POLICY_PATH")"
  [[ "$canonical_policy" == "$(<"$POLICY_PATH")" ]] || fail 'policy_not_canonical'
  actual_digest="$(policy_digest "$POLICY_PATH")"
  configured_digest="$(<"$DIGEST_PATH")"
  [[ "$configured_digest" == "$actual_digest" ]] || fail 'policy_digest_drift'
  if [[ -n "$expected_digest" ]]; then
    [[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]] || fail 'expected_digest_invalid'
    [[ "$expected_digest" == "$actual_digest" ]] || fail 'expected_digest_mismatch'
  fi
  network_matches_contract || fail 'network_contract_mismatch'
  ipv6_boundary_matches_contract || fail 'ipv6_contract_mismatch'
  network_has_no_containers || fail 'unexpected_network_container'
  address_map_matches_controlled_resolution || fail 'address_map_resolution_drift'
  rendered_configs_match || fail 'rendered_config_drift'
  units_match_contract || fail 'service_unit_identity_mismatch'
  dnsmasq --test --conf-file="$DNSMASQ_CONFIG" >/dev/null 2>&1 || fail 'dns_config_invalid'
  haproxy -c -f "$HAPROXY_CONFIG" >/dev/null 2>&1 || fail 'gateway_config_invalid'
  listener_owned_by_unit tcp 53 "$DNS_SERVICE" "$DNS_EXECUTABLE" || fail 'dns_tcp_listener_identity_mismatch'
  listener_owned_by_unit udp 53 "$DNS_SERVICE" "$DNS_EXECUTABLE" || fail 'dns_udp_listener_identity_mismatch'
  listener_owned_by_unit tcp 443 "$GATEWAY_SERVICE" "$GATEWAY_EXECUTABLE" || fail 'gateway_listener_identity_mismatch'
  firewall_matches_contract || fail 'firewall_contract_mismatch'
  verify_gateway_resolution
  write_evidence "$actual_digest"
  printf '%s\n' "OVD-420 recovery egress readiness passed: contract=$CONTRACT_ID policy_sha256=$actual_digest"
}

credential_directory_for_mode() {
  local mode="$1"
  if [[ "$mode" == 'classifier-only' ]]; then
    printf '%s\n' '/var/lib/ovd410-classifier-diagnostic'
  else
    printf '%s\n' '/var/lib/ovd410-credential'
  fi
}

launch_browser() {
  local mode="$1" image="$2" credential_dir="$3"
  local container_name expected_dir expected_digest command_status=0
  require_root
  [[ "$mode" == 'classifier-only' || "$mode" == 'full-recovery' ]] || fail 'launch_mode_invalid'
  [[ "$image" =~ $WORKER_IMAGE_PATTERN ]] || fail 'worker_image_invalid'
  if [[ "$mode" == 'classifier-only' ]]; then
    container_name='ovd410-xometry-classifier-diagnostic'
  else
    container_name='ovd410-xometry-auth-recovery'
  fi
  expected_dir="$(credential_directory_for_mode "$mode")"
  [[ "$credential_dir" == "$expected_dir" && -d "$credential_dir" && ! -L "$credential_dir" ]] || fail 'credential_directory_invalid'
  expected_digest="${OVD420_RECOVERY_EGRESS_POLICY_SHA256:-}"
  [[ -n "$expected_digest" ]] || fail 'expected_digest_missing'
  verify_control "$expected_digest"

  set +e
  # This disposable single-tenant VM shares IPC so Camoufox MIT-SHM reaches host Xvfb.
  docker run --rm -it \
    --name "$container_name" \
    --network "$NETWORK_NAME" \
    --dns "$NETWORK_GATEWAY" \
    --dns-option timeout:1 \
    --dns-option attempts:1 \
    --sysctl net.ipv6.conf.all.disable_ipv6=1 \
    --sysctl net.ipv6.conf.default.disable_ipv6=1 \
    --ipc=host \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --env DISPLAY=:99 \
    --env WORKER_MODE=simulate \
    --env XOMETRY_BROWSER_ENGINE=camoufox \
    --env XOMETRY_USER_DATA_DIR=/credential/profile \
    --env PLAYWRIGHT_HEADLESS=true \
    --env PLAYWRIGHT_CAPTURE_TRACE=false \
    --env PLAYWRIGHT_BROWSER_TIMEOUT_MS=45000 \
    --env HTTP_PROXY= \
    --env HTTPS_PROXY= \
    --env ALL_PROXY= \
    --env NO_PROXY= \
    --env "OVD420_RECOVERY_EGRESS_CONTRACT_ID=$CONTRACT_ID" \
    --env "OVD420_RECOVERY_EGRESS_POLICY_SHA256=$expected_digest" \
    --volume /tmp/.X11-unix:/tmp/.X11-unix \
    --volume "$credential_dir:/credential" \
    "$image" \
    node dist/tools/xometryAuth.js
  command_status="$?"
  set -e

  if ! ( verify_control "$expected_digest" >/dev/null 2>&1 ); then
    fail 'post_launch_verification_failed'
  fi
  return "$command_status"
}

teardown_control() {
  require_root
  systemctl disable --now "$GATEWAY_SERVICE" "$DNS_SERVICE" >/dev/null 2>&1 || true
  if iptables -C INPUT -i "$NETWORK_BRIDGE" -j "$INPUT_CHAIN" >/dev/null 2>&1; then
    iptables -D INPUT -i "$NETWORK_BRIDGE" -j "$INPUT_CHAIN"
  fi
  if iptables -C DOCKER-USER -i "$NETWORK_BRIDGE" -j "$FORWARD_CHAIN" >/dev/null 2>&1; then
    iptables -D DOCKER-USER -i "$NETWORK_BRIDGE" -j "$FORWARD_CHAIN"
  fi
  iptables -F "$INPUT_CHAIN" >/dev/null 2>&1 || true
  iptables -X "$INPUT_CHAIN" >/dev/null 2>&1 || true
  iptables -F "$FORWARD_CHAIN" >/dev/null 2>&1 || true
  iptables -X "$FORWARD_CHAIN" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
  rm -f \
    "$DNS_UNIT_PATH" \
    "$GATEWAY_UNIT_PATH" \
    "$DNSMASQ_CONFIG" \
    "$HAPROXY_CONFIG" \
    "$ADDRESS_MAP_PATH" \
    "$POLICY_PATH"
  rm -rf "$STATE_DIR"
  rm -f "$INSTALL_PHASE_PATH"
  systemctl daemon-reload
}

validate_policy_command() {
  local source_policy="$1"
  local canonical_policy
  require_commands jq sha256sum
  canonical_policy="$(canonicalize_policy "$source_policy")"
  printf '%s' "$canonical_policy" | sha256sum | awk '{print $1}'
}

usage() {
  printf '%s\n' \
    'usage:' \
    '  ovd420-recovery-egress-control.sh install <policy-json>' \
    '  ovd420-recovery-egress-control.sh validate <policy-json>' \
    '  OVD420_RECOVERY_EGRESS_TEST_RENDER=1 ovd420-recovery-egress-control.sh test-resolve <policy-json> <address-map> <resolver-host> <resolver-port>' \
    '  OVD420_RECOVERY_EGRESS_TEST_RENDER=1 ovd420-recovery-egress-control.sh test-render <policy-json> <address-map> <dns-config> <haproxy-config>' \
    '  OVD420_RECOVERY_EGRESS_TEST_RENDER=1 ovd420-recovery-egress-control.sh test-resolution-match <policy-json> <address-map> <resolver-host> <resolver-port>' \
    '  ovd420-recovery-egress-control.sh verify [expected-policy-sha256]' \
    '  ovd420-recovery-egress-control.sh launch <classifier-only|full-recovery> <immutable-worker-image> <credential-dir>' \
    '  ovd420-recovery-egress-control.sh teardown'
}

main() {
  local action="${1:-}" argument_one="${2:-}" argument_two="${3:-}"
  local argument_three="${4:-}" argument_four="${5:-}"
  case "$action" in
    install)
      [[ "$#" -eq 2 ]] || fail 'install_arguments_invalid'
      install_control "$argument_one"
      ;;
    validate)
      [[ "$#" -eq 2 ]] || fail 'validate_arguments_invalid'
      validate_policy_command "$argument_one"
      ;;
    test-resolve)
      [[ "$#" -eq 5 ]] || fail 'test_resolve_arguments_invalid'
      resolve_test_address_map "$argument_one" "$argument_two" "$argument_three" "$argument_four"
      ;;
    test-render)
      [[ "$#" -eq 5 ]] || fail 'test_render_arguments_invalid'
      render_test_config "$argument_one" "$argument_two" "$argument_three" "$argument_four"
      ;;
    test-resolution-match)
      [[ "$#" -eq 5 ]] || fail 'test_resolution_match_arguments_invalid'
      verify_test_resolution_match "$argument_one" "$argument_two" "$argument_three" "$argument_four"
      ;;
    verify)
      [[ "$#" -le 2 ]] || fail 'verify_arguments_invalid'
      verify_control "$argument_one"
      ;;
    launch)
      [[ "$#" -eq 4 ]] || fail 'launch_arguments_invalid'
      launch_browser "$argument_one" "$argument_two" "$argument_three"
      ;;
    teardown)
      [[ "$#" -eq 1 ]] || fail 'teardown_arguments_invalid'
      teardown_control
      ;;
    *)
      usage >&2
      exit 64
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
