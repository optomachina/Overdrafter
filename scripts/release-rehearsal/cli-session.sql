-- OVD-660 fixed diagnostic. Never part of the release migration history.
BEGIN;
CREATE SCHEMA ovd660_cli_session;
CREATE TABLE ovd660_cli_session.observation (singleton boolean PRIMARY KEY CHECK (singleton), evidence jsonb NOT NULL);
INSERT INTO ovd660_cli_session.observation (singleton, evidence)
WITH RECURSIVE roots(tag, name) AS (
  VALUES ('session'::text, session_user::text), ('current'::text, current_user::text)
), reachable(tag, roleid) AS (
  SELECT roots.tag, r.oid FROM roots JOIN pg_catalog.pg_roles r ON r.rolname = roots.name
  UNION
  SELECT reachable.tag, m.roleid FROM reachable JOIN pg_catalog.pg_auth_members m ON m.member = reachable.roleid
)
SELECT true, jsonb_build_object(
  'schema', 'overdrafter.cli-session-observation.v1',
  'sessionUser', session_user, 'currentUser', current_user, 'database', current_database(),
  'serverAddress', inet_server_addr(), 'clientAddress', inet_client_addr(),
  'serverPort', inet_server_port(), 'clientPort', inet_client_port(),
  'backendPid', pg_backend_pid(),
  'backendStart', (SELECT backend_start FROM pg_catalog.pg_stat_activity WHERE pid = pg_backend_pid()),
  'observedAt', clock_timestamp(),
  'settings', jsonb_build_object('role', current_setting('role'), 'searchPath', current_setting('search_path'),
    'statementTimeout', current_setting('statement_timeout')),
  'roles', (SELECT jsonb_agg(jsonb_build_object('kind', roots.tag, 'name', r.rolname,
    'superuser', r.rolsuper, 'inherit', r.rolinherit, 'createRole', r.rolcreaterole,
    'createDatabase', r.rolcreatedb, 'canLogin', r.rolcanlogin, 'replication', r.rolreplication,
    'bypassRls', r.rolbypassrls) ORDER BY roots.tag)
    FROM roots JOIN pg_catalog.pg_roles r ON r.rolname = roots.name),
  'directMemberships', (SELECT coalesce(jsonb_agg(r.rolname ORDER BY r.rolname), '[]')
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    WHERE m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)),
  'membershipEdges', (SELECT coalesce(jsonb_agg(jsonb_build_object('root', reachable.tag,
    'member', member.rolname, 'role', granted.rolname, 'grantor', grantor.rolname,
    'admin', m.admin_option, 'inherit', m.inherit_option, 'set', m.set_option)
    ORDER BY reachable.tag COLLATE "C", member.rolname COLLATE "C", granted.rolname COLLATE "C", grantor.rolname COLLATE "C"), '[]')
    FROM reachable JOIN pg_catalog.pg_auth_members m ON m.member = reachable.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor),
  'reachableRoles', (SELECT jsonb_agg(jsonb_build_object('root', reachable.tag, 'name', r.rolname,
    'member', pg_has_role((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = roots.name), r.oid, 'MEMBER'), 'usable', pg_has_role((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = roots.name), r.oid, 'USAGE'))
    ORDER BY reachable.tag COLLATE "C", r.rolname COLLATE "C")
    FROM reachable JOIN roots ON roots.tag = reachable.tag JOIN pg_catalog.pg_roles r ON r.oid = reachable.roleid),
  'owners', jsonb_build_object(
    'ovd660_cli_session', (SELECT pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = 'ovd660_cli_session'),
    'ovd660_cli_session.observation', (SELECT pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'ovd660_cli_session.observation'::regclass))
);
COMMIT;
