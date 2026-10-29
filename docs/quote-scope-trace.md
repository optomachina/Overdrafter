# Quote scope trace: corrected drawing properties

This traces a client correction of extracted drawing properties through to the
scope that the quote worker snapshots and discloses to a provider. It was read
from source only; no database was run and no SQL was changed.

Result in one line: material, finish, tolerance, quantity, and the other
approved fields all reach the scope snapshot, and material, finish, tolerance,
quantity, and process also change what live adapters are asked or decide
(tolerance only for Xometry and SendCutSend). A corrected need-by date does
not reach the scope until the client separately confirms it, and no client
code path currently performs that confirmation.

## Hops

1. Client edit. `updateClientPartRequest` in
   `src/features/quotes/api/jobs-api.ts:1216` sends `p_material`, `p_finish`,
   `p_tightest_tolerance_inch`, `p_quantity`, `p_requested_quote_quantities`,
   and `p_requested_by_date` to the `api_update_client_part_request` RPC
   (`jobs-api.ts:1224-1245`). The legacy-signature fallback sends the same
   arguments (`jobs-api.ts:1248-1275`).
2. Override resolution. The current RPC definition is in
   `supabase/migrations/20260408120000_add_revision_process_to_property_overrides.sql:421-714`
   (later migrations only change grants, e.g.
   `20261015074957_ovd736_revoke_anon_definer_execute.sql:77,153`). It records
   a field as an override when it differs from the extracted default
   (lines 539-585), then resolves effective values (lines 587-595).
3. Approved requirement. The RPC upserts `approved_part_requirements` with
   the effective description, part number, revision, material, finish,
   tolerance, `quantity`, `quote_quantities`, and `requested_by_date`
   (lines 664-691). The effective quantity is `quote_quantities[1]`
   (line 601). It also rewrites `spec_snapshot` (lines 612-648), including
   process, threads, and `requestedByDate`.
4. Deadline history trigger. When revision or `requested_by_date` changes,
   `private.record_part_deadline_change` inserts a history row with state
   `inferred`, not `confirmed`
   (`supabase/migrations/20260926225000_confirm_sourcing_intent.sql:220-245`).
5. Lane reservation (request time). `private.quote_lane_candidates` builds one
   lane per vendor and per quantity in `quote_quantities`
   (`20260926225000_confirm_sourcing_intent.sql:436-475`), calling
   `private.build_quote_lane_scope_snapshot` (`:378-430`). The fingerprint is
   a SHA-256 of the snapshot text
   (`20260812041000_add_quote_scope_validity_and_lane_eligibility.sql:281-289`).
   Reserved lanes are stored in `quote_request_lanes` and drive
   `vendor_quote_results.requested_quantity`
   (`20260812044000_enforce_quote_lane_eligibility.sql:625-656`).
6. Worker load. `worker/src/partContext.ts:48` reads the current
   `approved_part_requirements` row.
7. Worker scope. `worker/src/index.ts:1694-1712` fetches the server-confirmed
   sourcing intent (`api_get_worker_sourcing_intent`,
   `20260926225000_confirm_sourcing_intent.sql:495-515`), then calls
   `buildQuoteLaneScopeSnapshot` in `worker/src/quoteScope.ts:120-166` with
   `requestedQuantity: currentResult.requested_quantity`.
8. Cross-check. `api_register_quote_request_lane`
   (`20260817054500_accept_semantically_equivalent_quote_scopes.sql:16-119`)
   rejects the worker snapshot if it differs from the reserved lane
   (lines 105-116), so a TypeScript/SQL mismatch fails closed.
9. Provider request. Adapters receive the live requirement and the lane
   quantity (`worker/src/index.ts:1756-1766`), not the snapshot.

## Per field

| Field | Scope snapshot | Provider request | Status |
| --- | --- | --- | --- |
| Material | `quoteScope.ts:159` | Sent: `adapters/xometry.ts:2971`, `adapters/fictiv.ts:1382`. Matched or gated: `adapters/sendcutsend.ts:640,670` (manifest match, envelope decision), `adapters/fabworks.ts:492` (eligibility input). Validation only: `adapters/oshcut.ts:195,203` (empty and exact 6061-T6 checks) | Flows |
| Finish | `quoteScope.ts:160` | Sent: `adapters/xometry.ts:2990`, `adapters/fictiv.ts:1399`. Matched or gated: `adapters/sendcutsend.ts:641,671` | Flows |
| Tightest tolerance | `quoteScope.ts:161` | Xometry live path: tier chosen at `adapters/xometry.ts:3229-3230`, set on the page at `:3330-3332`, recorded at `:3489`. SendCutSend: manifest match `adapters/sendcutsend.ts:642`, envelope decision `:672`. Fictiv: `adapters/fictiv.ts:1332` (<= 0.002 forces manual review) is inside `simulateQuote`, which runs only when `workerMode` is not live (`:1988-1989`). `adapters/base.ts:24-26` is simulated pricing only. Not read by fabworks, oshcut, or rmfg | Flows to Xometry and SendCutSend; simulation only for Fictiv |
| Quantity | `quoteScope.ts:143` from the lane quantity | Adapters use `input.requestedQuantity` (the lane quantity); `adapters/base.ts:22`, `adapters/xometry.ts:116`, `adapters/fictiv.ts:186` fall back to `requirement.quantity` only if it is falsy. Also `adapters/fabworks.ts:500`, `adapters/sendcutsend.ts:673` | Flows, via `quote_quantities` |
| Need-by date | `quoteScope.ts:162`, confirmed date only | No adapter reads `requested_by_date` | Gated, see below |
| Description, part number, revision | `quoteScope.ts:156-158` | No adapter reads `requirement.description`, `part_number`, or `revision` (searched `worker/src/adapters`) | Scope only |
| Process (in `spec_snapshot`) | `quoteScope.ts:163` | `adapters/sendcutsend.ts:639,669`, `adapters/fabworks.ts:491`, `adapters/oshcut.ts:151`, `adapters/rmfg.ts:205` (eligibility and envelope inputs) | Flows |
| Threads (in `spec_snapshot`) | `quoteScope.ts:163` | No adapter reads a threads field; `adapters/xometry.ts:2599` is only a page label | Scope only |

Notes on quantity: `requirement.quantity` alone does not change the lane
scope. The lane quantity comes from `quote_quantities` (step 5), and the RPC
sets `quantity` to its first element (step 3). They agree after a client edit.

## Quantity admission for the Xometry controlled beta

Migration `20261020100000_ovd987_controlled_beta_user_quantity` (OVD-987)
changes which quantity the Xometry controlled beta admits. It does not change
the lane, the scope snapshot or the fingerprint, which already carry the
quantity (steps 5 to 8). It adds the rollout control
`controlled_beta_user_quantity`, off unless an operator turns it on, and
restates the dispatch resolver, the request function, the worker authorization
and the three free-beta meter functions. This trace was read from source and
from that migration; no database was run.

- With the control off, the normalized quote quantities must be exactly `[1]`
  (`xometry_beta_quantity_one_required`). With it on, they must be exactly one
  positive integer (`xometry_beta_single_quantity_required` for several, or for
  none after normalization). Only the lane for that quantity is created, so
  the one-lane-per-request rule is unchanged.
- The request function requires the created lane to carry the scope's quantity
  (the quantity `1` while the control is off), else
  `xometry_beta_created_lane_mismatch`.
- The quantity is inside the fingerprint, so a request confirmed at one
  quantity and saved at another fails with `xometry_beta_scope_changed`.
- The worker authorization, which runs before hop 9, requires the lane's
  quantity to equal its own snapshot quantity, and the result's
  `requested_quantity` and the task payload's `requestedQuantity` (when the
  payload has that key) to equal the lane's, else
  `dispatch_lane_identity_mismatch`. The quantity the adapter browses with is
  therefore the quantity the permit names. A lane above `1` is refused with
  `dispatch_quantity_not_admitted` while the control is off.
- The meter functions compare the lane's quantity with its own snapshot and the
  result's quantity with the lane's. They never read the control, so a permit
  issued at quantity N still settles after the control is turned off.

Operator rules for the control are in
[Commercial Rollout Controls](workflows/commercial-rollout-controls.md#controlled-beta-user-quantity),
and the envelope rule is in the
[1.0 runbook](1-0-beta-runbook.md#quantity-in-controlled-beta-requests).

## Need-by date

A corrected need-by date is written to `approved_part_requirements.requested_by_date`
and to `spec_snapshot.requestedByDate` (step 3). It is deliberately not used in
the scope. The scope's `requestedDeliveryDate` is only the active confirmed
deadline, `private.current_confirmed_part_deadline`
(`20260926225000_confirm_sourcing_intent.sql:247-276`), which returns a date
only when the latest history row is `confirmed`, matches the current
requirement, revision, and date, and is not in the past. Both TypeScript
(`quoteScope.ts:86-95`) and SQL (`:361-376`) strip `requestedByDate` and
`shipping.requestedByDateOverride` from the specification.

So a client correction of the need-by date changes the scope only after
`api_confirm_part_deadline` records a confirmation
(`20260926225000_confirm_sourcing_intent.sql:312-358`). Until then the scope
carries `requestedDeliveryDate: null`. A repository search found no
TypeScript caller of `api_confirm_part_deadline`; it appears only in the
generated `src/integrations/supabase/types.ts`. Changing only a non-deadline
field keeps an existing confirmation valid, since the trigger writes a row
only when revision or date changes.

## Gaps (reported, not changed)

1. Need-by date: no client code path confirms a corrected deadline, so a
   corrected date does not reach the scope. Fix proposal: add a client call
   to `api_confirm_part_deadline` after the user reviews the date. This is
   product and SQL-adjacent work, so it is out of scope for this unit.
2. The TypeScript builder and the SQL builder must stay identical. The
   register RPC enforces this at runtime (step 8). The unit test
   `worker/src/quoteScopeOverrides.test.ts` pins the TypeScript side.

No TypeScript gap was found in `buildQuoteLaneScopeSnapshot`, so no code fix
is proposed.

## Verification

`npx vitest run worker/src/quoteScopeOverrides.test.ts` changes one approved
field at a time and fails if the scope ignores it, and checks that an
unconfirmed date never appears in the scope.

Adapter rows were verified by searching `worker/src/adapters` for `requirement.<field>` reads.
