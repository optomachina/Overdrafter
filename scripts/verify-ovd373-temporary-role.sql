-- OVD-373 temporary-role assumption proof.
-- This reads only connection identity. PGOPTIONS must authenticate through the
-- project-bound CLI role and assume postgres before any production write.

begin read only;

do $ovd373$
begin
  if session_user <> 'cli_login_postgres' or current_user <> 'postgres' then
    raise exception
      'OVD-373 temporary role mismatch: session %, current %',
      session_user,
      current_user;
  end if;
end;
$ovd373$;

select 'OVD-373 temporary-role verification passed.' as result;

commit;
