# Manufacturing characterization benchmark corpus

This directory is the reproducible, rights-gated input set for manufacturing
characterization research. It exists to compare parsers and geometry
dependencies before production feature recognition or customer-visible pricing
is allowed.

The v1 runner validates corpus integrity and readiness only. It does not invoke
production extraction, recognize features, score prices, write to a database,
or send files to an external provider.

## Current gate status

No manufacturing process is promotion-ready. The checked-in manifest contains
two project-authored adversarial fixtures to exercise malformed-input and
resource-limit declarations. Both remain excluded from coverage until data
governance approves their rights record and manufacturing review approves their
annotations.

The manifest intentionally reports the full launch gap:

- 25 eligible packages and 10 consented real packages for each broad-estimate
  process
- 10 eligible packages for each characterization-only process
- authoritative review for every counted annotation
- active, purpose-specific rights for every counted package

An unmet target is a machine-readable downstream promotion blocker. It is not a
passing empty-corpus result.

## Layout

```text
benchmarks/manufacturing-characterization/
  manifest.v1.json
  annotations/
  fixtures/
    synthetic/
```

The manifest records process targets, immutable file identities, source class,
rights state, purpose-specific permissions, processor restrictions, retention
and revocation state, annotations, expected bounded failures, and execution
limits.

Customer or otherwise proprietary assets must not be committed here. They live
in an approved tenant-scoped private store and are mounted as the `private`
corpus root. The public manifest may contain only opaque references and hashes;
it must not contain customer names, filenames, dimensions, thumbnails, consent
documents, or commercial payloads.

## Commands

Validate integrity and print the deterministic coverage report:

```bash
npm --prefix worker run corpus:validate
```

Fail while any process target remains blocked:

```bash
npm --prefix worker run corpus:validate -- --strict-coverage
```

Mount a private corpus root:

```bash
npm --prefix worker run corpus:validate -- --root private=/approved/private/corpus
```

Emit dependency inputs without annotation paths, expected outputs, source
classification, rights records, or process labels:

```bash
npm --prefix worker run corpus:validate -- --blind-plan
```

The default blind-plan purpose is local geometry-SDK evaluation. Use
`--purpose local_parser_evaluation` for parser comparisons and
`--processor <id>` for any non-local processor. Cases are excluded unless the
rights record permits the exact purpose and processor; exclusion reason codes
remain visible without exposing ground truth.

Exit codes are `0` for valid requested output, `1` for strict coverage gaps,
and `2` for a malformed or integrity-failing corpus.

The report omits timestamps, durations, absolute paths, and unordered values so
repeated runs over identical inputs are byte-stable.

## Adding a case

1. Establish the source class and an opaque source reference.
2. Record a separate rights entry. Evaluation, external geometry-SDK use,
   model validation, training, product improvement, demonstration, and
   publication are independent permissions.
3. Default processor access to `local_only`. Quoting consent does not authorize
   benchmark use or external-provider processing.
4. Add each source artifact with its exact byte size and SHA-256.
5. Add a versioned annotation with product structure, units, benchmark feature
   labels, requirements, candidate routes, unsupported states, and evidence
   locators.
6. Obtain manufacturing annotation approval and data-governance rights
   approval. Pending, expired, revoked, deleted, or unapproved cases remain
   visible but do not count toward promotion.
7. Run normal and strict validation. Review the quantified coverage delta.

The annotation vocabulary is a benchmark label set, not the production
manufacturing-characterization contract. OVD-241 owns that executable product
contract; future versions must map explicitly instead of silently reinterpreting
v1 annotations.

## Source register and quarantine

### NIST AP242 models

NIST publishes fully toleranced, simplified, combined, assembly, and hole test
cases. Its test-case page states that the CAD models and STEP files may be used
without restriction and requests acknowledgement:

- https://www.nist.gov/ctl/smart-connected-systems-division/smart-connected-manufacturing-systems-group/mbe-pmi-0
- https://www.nist.gov/copyrights-disclaimers

These are approved candidates for a redistributable standards cohort, but they
are not counted yet. Import work must pin the exact downloaded archive, record
per-file hashes and attribution, and create authoritative OverDrafter
annotations without using the NIST logo in promotional material.

### Existing repository fixtures

The existing `1093-05589-02` STEP/PDF package is described as real and has no
checked-in benchmark consent or permitted-use record. It is quarantined from
this corpus.

The existing `demo-bracket` assets also remain quarantined: STEP authorship is
not documented, and the SVG drawing geometry does not match the STEP model.
They may continue serving their current regression and UI-fixture roles, but
they cannot count toward manufacturing-characterization coverage until
provenance and package truth are resolved.
