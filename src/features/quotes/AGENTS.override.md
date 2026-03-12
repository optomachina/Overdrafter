# AGENTS.override.md

Applies to quote-related feature areas such as `src/features/quotes/`.

## Purpose

This override defines extra rules for quote provenance, comparison logic, and internal/client separation.

## Extra rules

- Preserve quote provenance.
- Do not leak internal-only sourcing context into client-facing views.
- Treat publication logic as high-risk.
- Keep comparison logic traceable and reviewable.
- Be careful with policy-aware transformations.

## Verification emphasis

For quote-related changes, prioritize:
- comparison correctness
- publication behavior
- internal/client data separation
- relevant UI or integration checks
