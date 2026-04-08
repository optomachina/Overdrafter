-- Migration: vendor_routing_scores
-- Purpose: Store computed routing scores for vendors against specific quote contexts (OVD-138)
-- Date: 2026-04-05

-- Vendor routing scores: computed scores per vendor per quote run
create table if not exists public.vendor_routing_scores (
  -- Unique identifier for this score record
  id uuid primary key default gen_random_uuid(),

  -- Which vendor this score applies to
  vendor_name public.vendor_name not null,

  -- The quote run this score was computed for
  quote_run_id uuid not null references public.quote_runs(id) on delete cascade,

  -- Organization scope (denormalized for RLS)
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Composite score (0-100)
  overall_score numeric(5, 2) not null,

  -- Price competitiveness score (0-100)
  price_score numeric(5, 2) not null,

  -- Lead time score (0-100)
  lead_time_score numeric(5, 2) not null,

  -- Quality score (0-100)
  quality_score numeric(5, 2) not null,

  -- How well vendor capabilities match the request (0-100)
  capability_match_score numeric(5, 2) not null,

  -- Domestic preference score (0-100)
  domestic_score numeric(5, 2) not null,

  -- Detailed per-dimension breakdown for auditing and debugging
  score_breakdown jsonb not null default '{}'::jsonb,

  -- When this score was computed
  computed_at timestamptz not null default timezone('utc', now()),

  -- Ensure one score per vendor per quote run
  unique (quote_run_id, vendor_name)
);

-- Index for efficient lookup of top-scoring vendors per quote run
create index if not exists idx_vendor_routing_scores_quote_run
on public.vendor_routing_scores(quote_run_id, overall_score desc);

-- Index for org-scoped queries
create index if not exists idx_vendor_routing_scores_org
on public.vendor_routing_scores(organization_id, quote_run_id);

-- RLS
alter table public.vendor_routing_scores enable row level security;

-- Internal users can read routing scores for their org
drop policy if exists "vendor_routing_scores_internal_select" on public.vendor_routing_scores;
create policy "vendor_routing_scores_internal_select"
on public.vendor_routing_scores
for select
to authenticated
using (public.is_internal_user(organization_id));

-- Internal users can manage routing scores for their org
drop policy if exists "vendor_routing_scores_manage_internal" on public.vendor_routing_scores;
create policy "vendor_routing_scores_manage_internal"
on public.vendor_routing_scores
for all
to authenticated
using (public.is_internal_user(organization_id))
with check (public.is_internal_user(organization_id));

-- Grant read access to authenticated users
grant select on public.vendor_routing_scores to authenticated;
