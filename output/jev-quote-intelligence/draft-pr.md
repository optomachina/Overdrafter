# Add bounded local Jev quote-intelligence review

A runnable synthetic local review pipeline now selects parsed quote evidence,
compares observed catalog options, chooses approved clarification templates, and
filters optional presentation context while retaining all source evidence.

All inference is off by default. Shadow mode audits proposals without changing rule
results; apply mode changes only local review recommendations. The service has no
vendor dispatch, customer persistence, or publication operation. Deterministic
constraints and source-span checks veto model outputs. Existing shared TypeSafe
transport is included as dependency commit fe95a263 (original 7b18ecf).

Verification: focused tests, CLI runs, lint/typechecks/build; aggregate result recorded
in handoff. Independent local review findings resolved. Synthetic baseline 0/4 versus
scripted oracle 4/4 is a contract demonstration, not Jev accuracy. Real inference,
external Astra review, hosted checks, and production effectiveness remain unverified.

No migrations or dependencies. Roll back by removing local review consumers or keeping
off mode. Docs: docs/workflows/jev-quote-intelligence.md. No UI demo applicable.

Publication pending coordinated issue linkage and remaining external review approval.
