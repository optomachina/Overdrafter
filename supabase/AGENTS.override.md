# AGENTS.override.md

Applies to the `supabase/` area.

## Purpose

This override defines extra rules for schema, migration, and data-boundary work.
It adds technical verification requirements only. The root `AGENTS.md` controls
development authorization, including the bounded synthetic-fixture lane.

## Extra rules

- Treat migrations as high-risk changes.
- Do not mix unrelated schema changes into one task.
- Preserve data-boundary intent and access-control assumptions.
- Review row-level security and access implications when modifying policies.
- Document migration impact in the PR.
- Include rollback notes when meaningful.
- Prefer the smallest safe schema change.
- Do not edit historical migrations casually unless the task explicitly requires it.
- Keep production targets, real credentials, and customer data outside synthetic
  fixtures. Fixture-generated ephemeral roles and synthetic records are allowed
  within the root fixture contract.

## Verification emphasis

For database-related changes, prioritize:
- migration validation
- relevant integration tests
- access-control verification
- rollback reasoning
- catalog, grant, RLS, transport-readiness, and cleanup evidence as separate
  verdicts; one passing layer does not imply another passed
