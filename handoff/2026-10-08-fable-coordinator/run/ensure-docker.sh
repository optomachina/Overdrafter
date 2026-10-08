#!/bin/sh
# Idempotent, lock-protected Docker self-heal for the shared cloud container.
# Worker-process restarts kill everything in the worker's memory cgroup; dockerd started from a
# tool shell lands there and dies with it. This script restarts dockerd when it is gone and moves
# dockerd, containerd and the container shims into their own cgroup so the next restart spares them.
set -u
C=/sys/fs/cgroup/memory/ovd-dockerd
exec 9>/tmp/ovd-dockerd.v2.lock
flock -w 180 9 || { echo "ensure-docker: lock busy for 180s; continuing without lock" >&2; }
if ! timeout 20 docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
  setsid nohup dockerd >/dev/shm/dockerd.log 2>&1 < /dev/null 9>&- &
  i=0
  while [ $i -lt 30 ]; do
    timeout 20 docker info >/dev/null 2>&1 && break
    sleep 2; i=$((i+1))
  done
  timeout 20 docker info >/dev/null 2>&1 || { echo "ensure-docker: dockerd did not come up; see /dev/shm/dockerd.log" >&2; exit 1; }
  echo "ensure-docker: dockerd restarted $(date -u +%H:%M:%SZ)"
fi
mkdir -p "$C" 2>/dev/null || true
if [ -w "$C/cgroup.procs" ]; then
  for p in $(pgrep -x dockerd) $(pgrep -x containerd) $(pgrep -f containerd-shim-runc-v2); do
    grep -q "memory:/ovd-dockerd" /proc/$p/cgroup 2>/dev/null || echo $p > "$C/cgroup.procs" 2>/dev/null || true
  done
fi
# Wait briefly for the shared Supabase stack to report healthy (it auto-restarts with dockerd).
i=0
while [ $i -lt 20 ]; do
  n=$(timeout 20 docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -c 'supabase_.*healthy')
  [ "$n" -ge 6 ] && break
  sleep 3; i=$((i+1))
done
timeout 20 docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep supabase_ | grep -v healthy | grep -v supabase_rest || true
echo "ensure-docker: ok ($(timeout 20 docker ps -q | wc -l) containers)"
