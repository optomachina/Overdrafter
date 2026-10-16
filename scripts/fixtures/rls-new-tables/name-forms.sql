create table "public"."Fixture_Quoted" (id uuid primary key);
alter table public."Fixture_Quoted" enable row level security;

CREATE TABLE Public.Fixture_Mixed_Case (id uuid primary key);
ALTER TABLE PUBLIC.FIXTURE_MIXED_CASE ENABLE ROW LEVEL SECURITY;

create table if not exists public.fixture_if_not_exists (id uuid primary key);
alter table if exists only public.fixture_if_not_exists enable row level security;

create table fixture_unqualified (id uuid primary key);
alter table "public".fixture_unqualified enable row level security;

Create Table If Not Exists "overdrafter".fixture_quoted_schema (id uuid primary key);
Alter Table overdrafter."fixture_quoted_schema" Enable Row Level Security;
