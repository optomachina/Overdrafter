#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly METADATA_ROOT="http://metadata.google.internal/computeMetadata/v1"
readonly METADATA_HEADER="Metadata-Flavor: Google"
readonly CREDENTIAL_DIR="/var/lib/ovd410-credential"
readonly READY_MARKER="/run/ovd410-recovery-host-ready"
readonly STARTUP_STATUS="/run/ovd410-recovery-host-status.json"
readonly EGRESS_INSTALL_PHASE="/run/ovd420-recovery-egress-install-phase"

OVD410_STARTUP_STAGE="bootstrap"

write_startup_status() {
  local stage="$1"
  local exit_code="$2"
  local status_tmp

  (( EUID == 0 )) || return 77
  case "$stage" in
    bootstrap|packages|docker|display|metadata|registry-auth|image-pull|egress-install|egress-dependencies|egress-policy|egress-resolution|egress-network|egress-configuration|egress-firewall|egress-services|egress-verification|egress-verify|display-verify|ready) ;;
    *) return 64 ;;
  esac
  [[ "$exit_code" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 64
  (( exit_code <= 255 )) || return 64

  status_tmp="$(mktemp "${STARTUP_STATUS}.tmp.XXXXXX")"
  printf '{"stage":"%s","exitCode":%s}\n' "$stage" "$exit_code" >"$status_tmp"
  chown root:root "$status_tmp"
  chmod 0600 "$status_tmp"
  mv -fT -- "$status_tmp" "$STARTUP_STATUS"
}

set_startup_stage() {
  OVD410_STARTUP_STAGE="$1"
  write_startup_status "$OVD410_STARTUP_STAGE" 0
}

record_startup_failure() {
  local exit_code="$1"
  local install_phase=''
  trap - ERR
  if [[ "$OVD410_STARTUP_STAGE" == 'egress-install' &&
        -f "$EGRESS_INSTALL_PHASE" && ! -L "$EGRESS_INSTALL_PHASE" &&
        "$(stat -c '%u:%g:%a' -- "$EGRESS_INSTALL_PHASE" 2>/dev/null)" == '0:0:600' ]]; then
    install_phase="$(<"$EGRESS_INSTALL_PHASE")"
    case "$install_phase" in
      dependencies|policy|resolution|network|configuration|firewall|services|verification)
        OVD410_STARTUP_STAGE="egress-$install_phase"
        ;;
    esac
  fi
  write_startup_status "$OVD410_STARTUP_STAGE" "$exit_code" || true
  exit "$exit_code"
}

trap 'record_startup_failure "$?"' ERR
set_startup_stage bootstrap

export DEBIAN_FRONTEND=noninteractive
set_startup_stage packages
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates \
  curl \
  dnsmasq-base \
  dnsutils \
  docker.io \
  haproxy \
  iproute2 \
  jq \
  novnc \
  websockify \
  x11vnc \
  xvfb
rm -rf /var/lib/apt/lists/*

set_startup_stage docker
install -d -m 0700 "$CREDENTIAL_DIR"
systemctl enable --now docker >/dev/null
# No container may use the GCE metadata resolver or token endpoint directly.
# The host gateway resolves approved names itself through its separately
# verified resolver path; browser containers remain on an internal network.
if ! iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null; then
  iptables -A DOCKER-USER -d 169.254.169.254/32 -j REJECT
fi

set_startup_stage display
install -m 0644 /dev/stdin /etc/systemd/system/ovd410-xvfb.service <<'UNIT'
[Unit]
Description=OVD-410 private recovery display
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x900x24 -nolisten tcp
Restart=no
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

install -m 0644 /dev/stdin /etc/systemd/system/ovd410-x11vnc.service <<'UNIT'
[Unit]
Description=OVD-410 localhost-only VNC bridge
Requires=ovd410-xvfb.service
After=ovd410-xvfb.service

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 -localhost -forever -shared -nopw -rfbport 5900
Restart=on-failure
RestartSec=1
NoNewPrivileges=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

install -m 0644 /dev/stdin /etc/systemd/system/ovd410-novnc.service <<'UNIT'
[Unit]
Description=OVD-410 localhost-only noVNC bridge
Requires=ovd410-x11vnc.service
After=ovd410-x11vnc.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
Restart=no
NoNewPrivileges=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now ovd410-xvfb.service ovd410-x11vnc.service ovd410-novnc.service >/dev/null

set_startup_stage metadata
OVD410_WORKER_IMAGE="$({
  curl -fsS \
    -H "$METADATA_HEADER" \
    "$METADATA_ROOT/instance/attributes/ovd410-worker-image"
} 2>/dev/null)"
readonly OVD420_CONTROL_TMP='/run/ovd420-recovery-egress-control.tmp'
readonly OVD420_POLICY_TMP='/run/ovd420-recovery-egress-policy.tmp'
readonly OVD420_CONTROL_PATH='/usr/local/sbin/ovd420-recovery-egress-control'
curl -fsS \
  -H "$METADATA_HEADER" \
  "$METADATA_ROOT/instance/attributes/ovd420-recovery-egress-control" \
  >"$OVD420_CONTROL_TMP"
curl -fsS \
  -H "$METADATA_HEADER" \
  "$METADATA_ROOT/instance/attributes/ovd420-recovery-egress-policy" \
  >"$OVD420_POLICY_TMP"
install -o root -g root -m 0700 "$OVD420_CONTROL_TMP" "$OVD420_CONTROL_PATH"
readonly OVD410_REGISTRY_HOST="us-west1-docker.pkg.dev"
readonly OVD410_IMAGE_PATTERN='^us-west1-docker\.pkg\.dev/overdrafter-worker-9133/cloud-run-source-deploy/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$'
if ! printf '%s' "$OVD410_WORKER_IMAGE" | grep -Eq "$OVD410_IMAGE_PATTERN"; then
  printf '%s\n' "Recovery host image metadata is invalid; refusing readiness." >&2
  record_startup_failure 1
fi

set_startup_stage registry-auth
OVD410_ACCESS_TOKEN="$({
  curl -fsS \
    -H "$METADATA_HEADER" \
    "$METADATA_ROOT/instance/service-accounts/default/token"
} 2>/dev/null | jq -er '.access_token')"

cleanup_registry_session() {
  docker logout "$OVD410_REGISTRY_HOST" >/dev/null 2>&1 || true
  rm -f "$OVD420_CONTROL_TMP" "$OVD420_POLICY_TMP"
  unset OVD410_ACCESS_TOKEN
}
trap cleanup_registry_session EXIT

printf '%s' "$OVD410_ACCESS_TOKEN" | docker login \
  --username oauth2accesstoken \
  --password-stdin \
  "https://$OVD410_REGISTRY_HOST" >/dev/null
unset OVD410_ACCESS_TOKEN
set_startup_stage image-pull
docker pull --quiet "$OVD410_WORKER_IMAGE" >/dev/null
docker image inspect "$OVD410_WORKER_IMAGE" >/dev/null

set_startup_stage egress-install
systemctl disable --now haproxy.service >/dev/null 2>&1 || true
"$OVD420_CONTROL_PATH" install "$OVD420_POLICY_TMP"
rm -f "$OVD420_CONTROL_TMP" "$OVD420_POLICY_TMP"

set_startup_stage egress-verify
systemctl is-active --quiet docker
iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT
"$OVD420_CONTROL_PATH" verify
set_startup_stage display-verify
systemctl is-active --quiet ovd410-xvfb.service
systemctl is-active --quiet ovd410-x11vnc.service
systemctl is-active --quiet ovd410-novnc.service
install -m 0600 /dev/null "$READY_MARKER"
set_startup_stage ready
printf '%s\n' "OVD-410 recovery host readiness controls passed."
