# Derived cumulative STEP preview fixtures

These fixtures derive from synthetic OVD-502 Workstation exports at source
`1b0360f2492ddc47a28339bfe820071732f2c255` (SolidWorks 2022 SP5).
The original 878402-byte evidence packet has SHA256
`ec6bbf1f5025fe1e42ffb3acf3b735e8e3ab625e59d83cc7eef31212d416293a`.
The original embedded file lengths and digests were checked before extraction.

The committed export reports are **derived, sanitized evidence**: every absolute
candidate/dependency/occurrence path uses the deterministic root
`C:\OverDrafter\fixture\preview-<depth>mm\candidate`. Original developer paths
were removed. Report bytes and bundle report digests were regenerated, and JSON
formatting was normalized. The contexts and embedded STEP bytes are unchanged;
these new text hashes are not the original qualification receipt hashes.

Tests replay retained geometry and derived reports. Registry and process
admissions are simulated; altered test fixtures intentionally recompute hashes
for semantic rejection. Replay is not new native execution, authentication,
trusted filesystem admission, native-file remeasurement or deployed storage
proof. See `scripts/native/prepared-preview/README.md` for source-specific native
and independent STEP geometry qualification.

| File | Bytes | SHA256 |
|---|---:|---|
| preview-9mm/context.json | 3767 | `7895dd017c69ffce4db84ae88b37343845fe99493d204b0b6852259839d08a2b` |
| preview-9mm/preview.json | 46369 | `fceee76fad6cfdead597ce5585fe021801c38d7f369b1a86643411f4fd2c9067` |
| preview-9mm/native-step.stdout.txt | 7886 | `f6879b2c71f5aaf283a845711e5bbfbb8a277cf4064e608eacc86fb5c0db3e33` |
| preview-7mm/context.json | 3767 | `7a180e25dab6203a3c07a715c5006785bd9c4b085da256b34fca0c52a6115e31` |
| preview-7mm/preview.json | 46341 | `e584aacdb417f209c4fbfe5944e018ba9fa6164a2e09954a5900404e9707adf5` |
| preview-7mm/native-step.stdout.txt | 7923 | `a7cf12896045d4c1c2df3ed881fbf5bce46a901209ebdad1447a300dee6333cd` |
