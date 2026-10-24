#!/usr/bin/env bash
# QA only: apply a worktree's migrations to a throwaway local PG17 db (unix socket /tmp:55476).
set -u
WT=$1; DB=$2; STUB=${3:-/workspace/qa-batch/776-supabase-stub.sql}
P="psql -h /tmp -p 55476 -U postgres -X -q"
$P -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
$P -d $DB -v ON_ERROR_STOP=1 -f "$STUB" >/dev/null 2>/tmp/$DB-stub.err || { echo "STUB FAIL"; cat /tmp/$DB-stub.err; exit 1; }
n=0
for f in $(ls "$WT"/supabase/migrations/*.sql | sort); do
  if ! $P -d $DB ${SINGLE:-} -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/$DB-mig.err; then
    echo "FAIL at $(basename $f) after $n ok"; grep -m3 ERROR /tmp/$DB-mig.err; exit 1
  fi
  n=$((n+1))
done
echo "applied $n migrations to $DB"
