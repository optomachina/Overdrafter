# Linear Label Taxonomy For RFQ Seed Import

## Reuse Existing Labels

These labels already exist in the `Overdraft` workspace and should be reused by default:

### Band

- `now`
- `next`
- `later`
- `sub-backlog`
- `roadmap`
- `roadmap-only`

### Area / theme

- `quotes`
- `workspace`
- `product-foundation`
- `review`
- `testing`

### Horizon

- `horizon-1`
- `horizon-2`
- `horizon-3`
- `horizon-4`
- `horizon-5`
- `horizon-6`

### Type

- `Feature`
- `Bug`
- `Improvement`
- `spike`

## Minimal New Labels Allowed

Only create these labels if they appear in `planning/linear_seed.yaml` and do not already exist:

| Label | Purpose | Color |
| --- | --- | --- |
| `draft` | Marks uncertain or deferred seed items that are not ready for active execution | `#94A3B8` |
| `free-tier` | Feature or behavior available on the default product tier | `#2563EB` |
| `paid-tier` | Feature or behavior gated behind paid plans | `#7C3AED` |
| `enterprise` | Feature or behavior gated to enterprise scope | `#0F766E` |

## Explicit Non-Goals

- Do not replace the existing workspace taxonomy with a new type/area system.
- Do not create broad new labels like `frontend`, `backend`, `infra`, or `compliance` unless the repo starts using them consistently outside this one import.
- Do not create a second set of labels that duplicates the meaning of `quotes`, `workspace`, `product-foundation`, `next`, or `sub-backlog`.

## Mapping Rules

- Current executable RFQ work should generally carry `quotes` plus one of `workspace` or `product-foundation`.
- Current-scope work imported into `Symphony` should usually carry `next` rather than `now`, because this pipeline is creating the next execution band, not an outage fix.
- Deferred roadmap items should use `sub-backlog` plus `roadmap-only` when imported into `Symphony Sub-Backlog`.
- Tier labels are additive and should never replace functional labels.
