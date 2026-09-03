# Live-continuation mode

Live evaluation is local, quote-only reconnaissance. It cannot admit a provider, persist customer offers, or authorize production routing.

## Prepare the exact approval tuple

Before browser launch, file staging, or provider interaction:

1. Resolve the manifest and adapter by exact provider key. Read allowed hosts from the reviewed portal definition; do not infer subdomains or redirects.
2. Resolve the account mode and isolated session owner. A missing, expired, shared, or ambiguous session stops the run.
3. Resolve each selected CAD and optional drawing to an absolute path. Require a regular, sanitized, non-export-controlled file supported by the adapter.
4. Compute SHA-256 from the exact bytes and show the digest beside each path. Do not expose the bytes.
5. Build the closed `provider-portal-approval.v1` descriptor for the provider key, account mode, canonical absolute CAD/drawing paths, exact ordered quantities, allowed origins, `quote_only` action, artifact scope, and exact CAD/drawing digests. Store it in a local regular non-symlink file, compute the descriptor file's SHA-256, and do not change the file after presenting it.
6. State the intended quote-only action, quantities, allowed origins, and the scrubbed artifact types/locations that may be produced. Screenshots are excluded unless the reviewed kernel has deterministic masking for that provider surface.

Present one approval request containing this full tuple:

```text
Provider: <stable-key>
Account mode: <mode>
CAD: <absolute-path>  sha256=<digest>
Drawing: <absolute-path or none>  sha256=<digest or none>
Quantities: <exact values>
Action: upload and configure these exact files only to obtain quote-only evaluation evidence
Allowed origins: <exact reviewed origins>
Artifacts: <scrubbed screenshot/HTML metadata and local evaluation JSON locations>
Approval descriptor: <absolute-json-path>  sha256=<descriptor-file-digest>
```

Proceed only after the user explicitly approves that exact provider, account mode, file-path/digest set, quantities, action, origins, artifact scope, and approval-descriptor path/digest. A changed byte, path, provider, account mode, quantity, origin, action, artifact scope, descriptor byte, or descriptor path invalidates approval and requires a new prompt.

The non-export-controlled confirmation flag is an assertion about the exact staged bytes, not a reusable permission. Do not infer it from a filename, earlier run, or broad instruction to finish onboarding.

## Execute within the kernel

Use the standalone evaluation command only after exact approval:

```bash
npm --prefix worker run eval:live-provider -- \
  --vendor <stable-key> \
  --cad <absolute-cad-path> \
  --drawing <absolute-drawing-path> \
  --quantities <comma-separated-values> \
  --approval-file <absolute-approval-json-path> \
  --approval-file-sha256 <approved-descriptor-file-digest> \
  --confirm-non-export-controlled
```

Omit `--drawing` when none was approved. Add only adapter-documented provider flags already present in the repository. Never use a production queue, permit, preflight, customer record, or admission-policy mutation as an evaluation shortcut.

Immediately before any eligibility hook, session-state read, browser launch, or upload, the entry point must reopen the descriptor safely, verify its bytes against `--approval-file-sha256`, parse its strict closed shape, re-resolve the CLI paths, recompute the selected file hashes, and compare the canonical paths, exact ordered quantities, and complete descriptor with the current reviewed provider definition. Missing or changed approval data stops without provider interaction.

The shared kernel must enforce exact authorized bytes, isolated storage state, allowed origins, bounded waits, intentional pre-mutation retries only, upload/configuration sequencing, scrubbed artifacts, anchored offers, and the checkout/order prohibition. Provider hooks may assess eligibility, configure the provider, classify portal state, and extract anchored offers with stable provider identifiers.

## Stop conditions

Stop without upload or further mutation when any of these occurs:

- login refresh or missing/expired session;
- CAPTCHA or another access-control challenge;
- manual review or unsupported package;
- unexpected origin, redirect, popup, or ambiguous navigation;
- selector drift or an unrecognized portal state;
- an ambiguous or possibly completed upload/configuration mutation;
- an order, cart, purchase, payment, checkout, account-creation, or contact action becomes reachable.

Do not bypass a control or retry an ambiguous mutation. A new login, selector repair, or changed scope requires a separate continuation and, when files or action change, a new exact approval.

## Evidence and reporting

Accept an offer only when price and lead-time facts are anchored to reviewed provider-specific locators and the normalized option retains stable provider ID, quantity, currency/price, lead time or unknown, validity or unknown, geographic origin or unknown, provenance, timestamps, and scrubbed artifact references. Whole-page or unanchored numbers remain evidence only and cannot become offers.

Keep evidence local. It may contain the provider key, manifest/envelope/adapter revisions, exact file hashes, account mode, timestamps, terminal state, normalized offers with non-sensitive stable offer/option identifiers, and scrubbed artifact references. It must not contain raw CAD/drawing bytes, credentials, cookies, tokens, provider-account/customer identifiers, raw unsanitized captures, or persisted customer offers.

Report the finite terminal state truthfully: success, login required, CAPTCHA, manual review, unsupported, unavailable, selector drift, unexpected origin, missing session, configuration failure, or another explicit kernel state. Evaluation-ready/evaluated never means production-certified.
