create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema private; create schema extensions;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function public.is_platform_admin() returns boolean language sql stable as $$ select coalesce(current_setting('qa.admin', true),'') = '1' $$;
create function public.current_user_has_aal2() returns boolean language sql stable as $$ select coalesce(current_setting('qa.aal2', true),'') = '1' $$;
create function public.require_verified_auth() returns uuid language plpgsql stable as $$ begin if auth.uid() is null then raise exception 'auth required' using errcode='42501'; end if; return auth.uid(); end $$;
create type public.vendor_name as enum ('xometry','fictiv','protolabs','sendcutsend','partsbadger','fastdms','devzmanufacturing','infraredlaboratories','oshcut','fabworks','ponoko','quickparts','rapiddirect','geomiq','weerg','protolabsnetwork','emachineshop','rmfg');
grant usage on schema private, public to service_role, authenticated;
