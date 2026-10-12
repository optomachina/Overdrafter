/** Fixed container-local libpq policy; no shell, credential lookup, or target input. */
export const SOCKET_CLIENT_ENV = Object.freeze([
  'env',
  // Empty PGSERVICE still requests a service named "". Remove it entirely.
  '-u', 'PGSERVICE', '-u', 'PGSERVICEFILE', '-u', 'PGHOSTADDR', '-u', 'PGPASSWORD',
  'PGHOST=/var/run/postgresql', 'PGPORT=5432',
  // /dev/null itself warns because it is not a regular file. A child of that
  // character device can never exist: libpq silently ignores its failed stat.
  'PGPASSFILE=/dev/null/ovd591-disabled-pgpass',
]);

/**
 * supabase_admin uses scram-sha-256 even on the image's local socket, so it needs the
 * owned fixture's generated password. The value is inherited by `docker exec -e
 * PGPASSWORD` from the provisioner's child environment and never appears in argv.
 */
export const SOCKET_ADMIN_CLIENT_ENV = Object.freeze(SOCKET_CLIENT_ENV.filter((value, index, all) =>
  !(value === 'PGPASSWORD' && all[index - 1] === '-u') && !(value === '-u' && all[index + 1] === 'PGPASSWORD')));
