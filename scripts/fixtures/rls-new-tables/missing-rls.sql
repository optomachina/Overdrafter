create table public.fixture_no_rls (
  id uuid primary key,
  label text not null
);

create index fixture_no_rls_label_idx on public.fixture_no_rls (label);
