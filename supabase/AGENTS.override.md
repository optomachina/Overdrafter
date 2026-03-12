# AGENTS.override.md

Applies to the `supabase/` area.

## Purpose

This override defines extra rules for schema, migration, and data-boundary work.

## Extra rules

- Treat migrations as high-risk changes.
- Do not mix unrelated schema changes into one task.
- Preserve data-boundary intent and access-control assumptions.
- Review row-level security and access implications when modifying policies.
- Document migration impact in the PR.
- Include rollback notes when meaningful.
- Prefer the smallest safe schema change.
- Do not edit historical migrations casually unless the task explicitly requires it.

## Verification emphasis

For database-related changes, prioritize:
- migration validation
- relevant integration tests
- access-control verification
- rollback reasoning
