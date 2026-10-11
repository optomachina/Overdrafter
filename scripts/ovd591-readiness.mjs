/** Read-only final-postmaster proof, compatible with the pinned Nix postgres wrapper. */
import { SOCKET_CLIENT_ENV } from './ovd591-libpq-environment.mjs';
export const FINAL_POSTMASTER_PROBE = `
fail() { printf 'readiness-not-ready:%s\\n' "$1"; exit 1; }
[ "$PGDATA" = /var/lib/postgresql/data ] || fail pgdata-env
[ "$(cat "$PGDATA/PG_VERSION" 2>/dev/null)" = 17 ] || fail pg-version
[ "$(sed -n '1p' "$PGDATA/postmaster.pid" 2>/dev/null)" = 1 ] || fail final-postmaster-pid
[ "$(sed -n '2p' "$PGDATA/postmaster.pid" 2>/dev/null)" = "$PGDATA" ] || fail postmaster-data-path
postgres_path=$(readlink -f "$(command -v postgres)") || fail postgres-package-path
[ -n "$postgres_path" ] || fail postgres-package-path
postgres_binary="$postgres_path"
# supabase/postgres17.6.1.095 withPackages wraps postgres with NIX_PGLIBDIR.
# Linux comm is truncated and may say .postgres-wrapp; never use it as identity.
wrapped_binary="$(dirname "$postgres_path")/.postgres-wrapped"
if [ -x "$wrapped_binary" ]; then postgres_binary=$(readlink -f "$wrapped_binary"); fi
pid1_binary=$(readlink -f /proc/1/exe) || fail pid1-executable
[ "$pid1_binary" = "$postgres_binary" ] || fail final-postmaster-executable
${SOCKET_CLIENT_ENV.join(' ')} \\
  pg_isready -h /var/run/postgresql -p 5432 -U postgres -d postgres -q || fail socket-not-ready
printf 'final-postmaster-ready\\n'
`.trim();

/** Same OS identity as the entrypoint's final postgres process; no added ptrace capability. */
export function readinessArguments(containerId) {
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('exact owned container ID required');
  return ['exec', '--user', 'postgres', containerId, 'sh', '-ceu', FINAL_POSTMASTER_PROBE];
}

/** Bounded post-failure diagnostics only for the already admitted owned ID.
 * The caller's evidence writer redacts its generated password before persistence. */
export async function retainReadinessDiagnostics(call, containerId) {
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('exact owned container ID required');
  const commands = [
    ['inspect', '--format', '{{json .State}}', containerId],
    ['logs', '--tail', '120', containerId],
    ['exec', '--user', 'postgres', containerId, 'sh', '-c',
      'printf "pid1-comm="; cat /proc/1/comm; printf "pid1-executable="; readlink -f /proc/1/exe; printf "packaged-postgres="; readlink -f "$(command -v postgres)"; printf "postmaster-pid-data-status\\n"; sed -n "1,2p;8p" /var/lib/postgresql/data/postmaster.pid'],
  ];
  for (const [index, args] of commands.entries()) {
    try { await call('docker', args, { label: `readiness-diagnostic-${index + 1}`, timeout: 3000, allowFailure: true, cleanup: true }); }
    catch { /* Diagnostic failure cannot bypass or replace owner-checked cleanup. */ }
  }
}
