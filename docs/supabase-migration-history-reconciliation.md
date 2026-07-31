# Supabase migration history reconciliation

Last verified: July 30, 2026

## Scope

Production already contains the commercial administration, entitlement, manual
quote lifecycle, and automatic-quote entitlement definitions. The deployed
migration ledger recorded those definitions under different timestamps than
the repository originally used.

This reconciliation changes only the four repository filenames shown below.
It does not change any SQL bytes, replay DDL, or mutate the remote migration
ledger.

## Verified commercial migration mapping

| Repository version before reconciliation | Production-recorded version | Migration | MD5 |
| --- | --- | --- | --- |
| `20260730100000` | `20260731015213` | `secure_commercial_admin_operations` | `c94295fc80d2a1dcd9062f1c66b99d29` |
| `20260730110000` | `20260731015226` | `add_organization_entitlements` | `b26edbaf958e4dbd60a26df36f5ae78d` |
| `20260730120000` | `20260731015235` | `add_manual_quote_request_lifecycle` | `65bbfc66516eb755a615167df51ca70d` |
| `20260730130000` | `20260731015240` | `gate_automatic_quotes_by_entitlement` | `1598257f7b79d5280f5c1d1f87a16342` |

The MD5 values were calculated from both sides of each comparison. Each pair
was byte-identical. Renaming the local file to its production-recorded version
therefore maps equivalent history without attempting to reapply an already
deployed definition.

## Deployment safety

Do not run a normal linked `supabase db push` yet. The four mappings above are
reconciled, but the broader repository-to-production migration ledger still
requires a dedicated audit. In particular:

- Local `20260726120000_add_spend_caps_and_ledger.sql` has MD5
  `19273aecad5d2dbb5791fb28db2eca98` and matches the production migration
  recorded as `20260731010001`; its timestamp alias remains unreconciled.
- Local and production both record
  `20260714032603_fix_client_drawing_preview_storage_path`, but their SQL bytes
  differ. The local file has MD5 `f1bffdde0d2e8bbdd1e884c4a05c4403`.
  The production definition must be preserved and compared during the broader
  audit; do not repair or replay this version based on the shared filename.
- Additional repository migrations are absent from the production ledger even
  though the current `public` and `private` schema diff is empty. Schema parity
  does not prove that data mutations, storage changes, or historical statements
  are equivalent.

Until that audit is complete, use linked migration commands only for read-only
inspection. Any proposed ledger repair must include statement-level evidence,
data and storage impact analysis, and an explicit rollback plan before it
changes production history.

## Verification and rollback

Verification for this reconciliation consists of:

1. comparing the SQL bytes before and after each rename;
2. confirming the four resulting filenames match the production ledger;
3. running repository migration validation without applying migrations; and
4. confirming no runtime schema or SQL-content diff exists.

Before this change is merged, rollback is simply restoring the four original
filenames. After merge, restoring those names would knowingly reintroduce the
commercial history mismatch and should occur only if production migration
history changes as part of a separately reviewed recovery.
