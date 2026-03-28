# North Star rollout guardrails

This document tracks implementation guardrails for the OverDrafter North Star project in Linear (`OVD-104` through `OVD-122`).

## Release gate

- Mainline must preserve the **classic workspace** as the default experience.
- North Star experience must remain behind an explicit toggle:
  - Environment gate: `VITE_ENABLE_NORTH_STAR_UI=1` (or `true` / `yes`)
  - URL gate: `?ui=northstar`
- If either gate is missing, the app stays on classic UI.

## Initial execution order

1. `OVD-104` — domain model contract
2. `OVD-105` — deterministic ingestion
3. `OVD-107` — normalized extraction + provenance
4. `OVD-111` — React workspace shell
5. `OVD-121` — observability and evaluation harness

## Integration rules

- Do not merge shell-first behavior that hard-codes North Star-only state contracts ahead of `OVD-104`.
- Keep orchestration and reveal-state behavior centralized (targeting `OVD-110`) instead of scattering UI-only conditionals.
- Any user-visible North Star behavior must ship with a rollback path via the classic UI toggle.
