-- Read-only named semantic catalog evidence, PostgreSQL 17. No application rows,
-- passwords, physical/OID identity or statistics. CLI ledger rows are separate.
BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL timezone = 'UTC';
WITH
namespaces AS (
  SELECT * FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema')
    AND nspname !~ '^pg_(toast|temp)(_|$)'
),
relations AS (
  SELECT c.*, format('%I.%I', n.nspname, c.relname) AS identity
  FROM pg_class c JOIN namespaces n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','S','f')
),
functions AS (
  SELECT p.*, format('%I.%I(%s)', n.nspname, p.proname,
    pg_get_function_identity_arguments(p.oid)) AS identity
  FROM pg_proc p JOIN namespaces n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f','p','w')
),
acl_inputs AS (
  SELECT 'schema' AS kind, format('%I', nspname) AS identity, nspacl AS acl FROM namespaces
  UNION ALL SELECT 'relation', identity, relacl FROM relations
  UNION ALL SELECT 'function', identity, proacl FROM functions
  UNION ALL SELECT 'column', c.identity || '.' || quote_ident(a.attname), a.attacl
    FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid WHERE a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT 'type', format('%I.%I',n.nspname,t.typname), t.typacl
    FROM pg_type t JOIN namespaces n ON n.oid=t.typnamespace
  UNION ALL SELECT 'defaultPrivilege', jsonb_build_array(pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype)::text,d.defaclacl
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
),
acls AS (
  SELECT i.kind,i.identity,
    CASE WHEN i.acl IS NULL THEN NULL ELSE COALESCE(
      jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
        'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
        ORDER BY pg_get_userbyid(a.grantor) COLLATE "C",
          (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) COLLATE "C",
          a.privilege_type COLLATE "C", a.is_grantable) FILTER (WHERE a.privilege_type IS NOT NULL),'[]'::jsonb) END AS value
  FROM acl_inputs i LEFT JOIN LATERAL aclexplode(i.acl) a ON true
  GROUP BY i.kind,i.identity,i.acl
),
records AS (
  SELECT jsonb_build_object('kind','schema','identity',format('%I',n.nspname),
    'owner',pg_get_userbyid(n.nspowner),'acl',acl.value,
    'types',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.typname,'kind',t.typtype,
      'owner',pg_get_userbyid(t.typowner),'acl',ta.value,'notNull',t.typnotnull,
      'baseType',CASE WHEN t.typbasetype=0 THEN NULL ELSE format_type(t.typbasetype,t.typtypmod) END,
      'default',t.typdefault,'enumLabels',COALESCE((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
        FROM pg_enum e WHERE e.enumtypid=t.oid),'[]'::jsonb),
      'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,false)) ORDER BY k.conname COLLATE "C")
        FROM pg_constraint k WHERE k.contypid=t.oid),'[]'::jsonb)) ORDER BY t.typname COLLATE "C")
      FROM pg_type t LEFT JOIN acls ta ON ta.kind='type' AND ta.identity=format('%I.%I',n.nspname,t.typname)
      WHERE t.typnamespace=n.oid AND t.typtype IN ('e','d')),'[]'::jsonb)) AS record
    FROM namespaces n JOIN acls acl ON acl.kind='schema' AND acl.identity=format('%I',n.nspname)
  UNION ALL
  SELECT jsonb_build_object('kind','role','identity',r.rolname,
    'attributes',jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'createRole',r.rolcreaterole,
      'createDb',r.rolcreatedb,'canLogin',r.rolcanlogin,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,
      'connectionLimit',r.rolconnlimit,'validUntil',r.rolvaliduntil,'config',r.rolconfig),
    'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),
      'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
      ORDER BY pg_get_userbyid(m.roleid) COLLATE "C",pg_get_userbyid(m.grantor) COLLATE "C")
      FROM pg_auth_members m WHERE m.member=r.oid),'[]'::jsonb)) FROM pg_roles r
  UNION ALL
  SELECT jsonb_build_object('kind','relation','identity',c.identity,'owner',pg_get_userbyid(c.relowner),
    'acl',acl.value,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
    'definition',jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'options',c.reloptions,
      'replicaIdentity',c.relreplident,'partitionKey',CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END,
      'partitionBound',pg_get_expr(c.relpartbound,c.oid,false),
      'parents',COALESCE((SELECT jsonb_agg(format('%I.%I',pn.nspname,pc.relname) ORDER BY i.inhseqno)
        FROM pg_inherits i JOIN pg_class pc ON pc.oid=i.inhparent JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE i.inhrelid=c.oid),'[]'::jsonb),
      'view',CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,false) END,
      'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'position',a.attnum,
        'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,
        'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid,false),'acl',ca.value,
        'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE format('%I.%I',cn.nspname,co.collname) END)
        ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
        LEFT JOIN acls ca ON ca.kind='column' AND ca.identity=c.identity||'.'||quote_ident(a.attname)
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
      'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid,false),'validated',k.convalidated)
        ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb),
      'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),
        'valid',i.indisvalid,'ready',i.indisready,'replicaIdentity',i.indisreplident) ORDER BY ic.relname COLLATE "C")
        FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),'[]'::jsonb),
      'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,false))
        ORDER BY t.tgname COLLATE "C") FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb),
      'sequence', (SELECT jsonb_build_object('type',format_type(s.seqtypid,NULL),'start',s.seqstart,'increment',s.seqincrement,
        'min',s.seqmin,'max',s.seqmax,'cache',s.seqcache,'cycle',s.seqcycle) FROM pg_sequence s WHERE s.seqrelid=c.oid)))
    FROM relations c JOIN acls acl ON acl.kind='relation' AND acl.identity=c.identity
  UNION ALL
  SELECT jsonb_build_object('kind','function','identity',f.identity,'owner',pg_get_userbyid(f.proowner),
    'acl',acl.value,'definition',pg_get_functiondef(f.oid),'securityDefiner',f.prosecdef,'config',f.proconfig)
    FROM functions f JOIN acls acl ON acl.kind='function' AND acl.identity=f.identity
  UNION ALL
  SELECT jsonb_build_object('kind','policy','identity',c.identity||'.'||quote_ident(p.polname),'relation',c.identity,
    'roles',(SELECT jsonb_agg(CASE WHEN roleid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(roleid) END
      ORDER BY (CASE WHEN roleid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(roleid) END) COLLATE "C") FROM unnest(p.polroles) roleid),
    'command',p.polcmd,'permissive',p.polpermissive,'using',pg_get_expr(p.polqual,p.polrelid,false),
    'withCheck',pg_get_expr(p.polwithcheck,p.polrelid,false)) FROM pg_policy p JOIN relations c ON c.oid=p.polrelid
  UNION ALL
  SELECT jsonb_build_object('kind','defaultPrivilege','identity',acl.identity,'owner',pg_get_userbyid(d.defaclrole),
    'schema',n.nspname,'objectType',d.defaclobjtype,'acl',acl.value)
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    JOIN acls acl ON acl.kind='defaultPrivilege' AND acl.identity=jsonb_build_array(pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype)::text
)
SELECT jsonb_build_object('schema','overdrafter.release-rehearsal-catalog.v1',
  'coverage',jsonb_build_array('schemas','roles','relations','functions','policies','defaultPrivileges'),
  'records',COALESCE(jsonb_agg(record ORDER BY (record->>'kind') COLLATE "C",(record->>'identity') COLLATE "C"),'[]'::jsonb))
FROM records;
COMMIT;
