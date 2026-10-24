-- Minimal Supabase-compat stub for disposable local PG17 (QA only)
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator noinherit login; create role supabase_admin superuser; create role supabase_storage_admin; create role supabase_auth_admin;
grant anon, authenticated, service_role to authenticator;
create schema extensions; create extension pgcrypto with schema extensions; create extension "uuid-ossp" with schema extensions;
alter database postgres set search_path = "$user", public, extensions;
create schema auth;
create table auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255), encrypted_password varchar(255),
  email_confirmed_at timestamptz, invited_at timestamptz, confirmation_token varchar(255), confirmation_sent_at timestamptz,
  recovery_token varchar(255), recovery_sent_at timestamptz, email_change_token_new varchar(255), email_change varchar(255),
  email_change_sent_at timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  is_super_admin boolean, created_at timestamptz, updated_at timestamptz, phone text unique, phone_confirmed_at timestamptz,
  phone_change text default '', phone_change_token varchar(255) default '', phone_change_sent_at timestamptz,
  confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current varchar(255) default '', email_change_confirm_status smallint default 0, banned_until timestamptz,
  reauthentication_token varchar(255) default '', reauthentication_sent_at timestamptz, is_sso_user boolean not null default false,
  deleted_at timestamptz, is_anonymous boolean not null default false);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id) on delete cascade, created_at timestamptz, updated_at timestamptz, aal text, not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'sub')),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role', true), (nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'role'))::text $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text not null unique, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), public boolean default false, avif_autodetection boolean default false, file_size_limit bigint, allowed_mime_types text[], owner_id text);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(), metadata jsonb, path_tokens text[] generated always as (string_to_array(name, '/')) stored, version text, owner_id text, user_metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
create function storage.filename(name text) returns text language sql immutable as $$ select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'),1)] $$;
grant usage on schema storage to anon, authenticated, service_role;
grant usage on schema public, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
