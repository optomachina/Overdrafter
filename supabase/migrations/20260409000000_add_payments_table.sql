-- payments table for Stripe payment intent lifecycle tracking
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  stripe_payment_intent_id text unique not null,  -- idempotency key
  amount_cents integer not null,
  status text not null check (status in ('authorized', 'captured', 'canceled', 'failed')),
  order_id uuid references public.projects(id) on delete set null,
  authorized_at timestamptz,
  captured_at timestamptz,
  canceled_at timestamptz,
  failed_at timestamptz,
  manual_followup_reason text,
  created_at timestamptz not null default now()
);

-- Only the service role can access payments (webhook + server functions)
alter table public.payments enable row level security;

create policy "service role full access"
  on public.payments
  for all
  to service_role
  using (true)
  with check (true);

-- Index for fast idempotency lookups
create index payments_stripe_payment_intent_id_idx
  on public.payments (stripe_payment_intent_id);
