#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly METADATA_ROOT="http://metadata.google.internal/computeMetadata/v1"
readonly METADATA_HEADER="Metadata-Flavor: Google"
readonly CREDENTIAL_DIR="/var/lib/ovd410-credential"
readonly READY_MARKER="/run/ovd410-recovery-host-ready"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates \
  curl \
  docker.io \
  jq \
  novnc \
  websockify \
  x11vnc \
  xvfb
rm -rf /var/lib/apt/lists/*

install -d -m 0700 "$CREDENTIAL_DIR"
systemctl enable --now docker >/dev/null
if ! iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null; then
  iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT
fi

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

OVD410_WORKER_IMAGE="$({
  curl -fsS \
    -H "$METADATA_HEADER" \
    "$METADATA_ROOT/instance/attributes/ovd410-worker-image"
} 2>/dev/null)"
if ! printf '%s' "$OVD410_WORKER_IMAGE" | grep -Eq '^.+@sha256:[0-9a-f]{64}$'; then
  printf '%s\n' "Recovery host image metadata is invalid; refusing readiness." >&2
  exit 1
fi

OVD410_ACCESS_TOKEN="$({
  curl -fsS \
    -H "$METADATA_HEADER" \
    "$METADATA_ROOT/instance/service-accounts/default/token"
} 2>/dev/null | jq -er '.access_token')"
OVD410_REGISTRY_HOST="${OVD410_WORKER_IMAGE%%/*}"

cleanup_registry_session() {
  docker logout "$OVD410_REGISTRY_HOST" >/dev/null 2>&1 || true
  unset OVD410_ACCESS_TOKEN
}
trap cleanup_registry_session EXIT

printf '%s' "$OVD410_ACCESS_TOKEN" | docker login \
  --username oauth2accesstoken \
  --password-stdin \
  "https://$OVD410_REGISTRY_HOST" >/dev/null
unset OVD410_ACCESS_TOKEN
docker pull --quiet "$OVD410_WORKER_IMAGE" >/dev/null
docker image inspect "$OVD410_WORKER_IMAGE" >/dev/null

systemctl is-active --quiet docker
iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT
systemctl is-active --quiet ovd410-xvfb.service
systemctl is-active --quiet ovd410-x11vnc.service
systemctl is-active --quiet ovd410-novnc.service
install -m 0600 /dev/null "$READY_MARKER"
printf '%s\n' "OVD-410 recovery host readiness controls passed."
