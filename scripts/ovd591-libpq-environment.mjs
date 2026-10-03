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
