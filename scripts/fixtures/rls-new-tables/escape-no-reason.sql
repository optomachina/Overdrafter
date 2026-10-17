create table public.fixture_hatch_no_reason ( -- lint-allow: rls-off
  id uuid primary key
);

create table public.fixture_hatch_empty_reason ( -- lint-allow: rls-off reason=""
  id uuid primary key
);
