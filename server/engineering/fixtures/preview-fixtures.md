# Retained cumulative STEP preview fixtures

These are byte-for-byte synthetic exports retained from OVD-502 Workstation
qualification at source `1b0360f2492ddc47a28339bfe820071732f2c255` (SolidWorks 2022 SP5).
The original 878402-byte evidence packet has SHA256
`ec6bbf1f5025fe1e42ffb3acf3b735e8e3ab625e59d83cc7eef31212d416293a`.
Each embedded file length and digest was checked before extraction.

Tests replay these real context, bundle and export-report bytes. The test registry
and process admissions are simulated; altered fixtures intentionally recompute
registration hashes to exercise semantic rejection. Replay is not new native
execution, server authentication, trusted admission or deployed storage proof.
The reports retain synthetic qualification paths, not customer files or secrets.
See `scripts/native/prepared-preview/README.md` for native and independent STEP
geometry qualification; an exchange envelope alone does not establish geometry.

| File | Bytes | SHA256 |
|---|---:|---|
| preview-9mm/context.json | 3767 | `7895dd017c69ffce4db84ae88b37343845fe99493d204b0b6852259839d08a2b` |
| preview-9mm/preview.json | 47064 | `e90853eae7135c175e981249283a3409dc4e8734b8cbf67d924850a0a9a98eb9` |
| preview-9mm/native-step.stdout.txt | 8472 | `090a84905098a2d4f840759aa8c2f18d529734ed47574da0cfccd8a2b66a2945` |
| preview-7mm/context.json | 3767 | `7a180e25dab6203a3c07a715c5006785bd9c4b085da256b34fca0c52a6115e31` |
| preview-7mm/preview.json | 47036 | `ca4608a70f232670cbcd79dca9644ec69fe454ae77a82ef2aa365ef6019e07c6` |
| preview-7mm/native-step.stdout.txt | 8510 | `592ad52e83d9cd221c6a2dd8ba9581fdd37512314592c9771099b2f4088afd4a` |
