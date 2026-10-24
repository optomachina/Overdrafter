QA: PASS on aed9bace3230820ca6787230427cf61ed3449e36
- Readback overwrite: `xometry.test.ts` drives Black Anodize -> As Machined and Sheet Cutting/5052-H32 -> CNC Machining/6061, with the result `requirementsVerified: true`. When the option is missing it still raises `saved_requirement_mismatch` (["finish"], ["process"]).
- Fixtures use the bare-dollar T1 summary text (`$41.41 ea. $414.15`, no USD marker). The PR body and the test comment give the source as `xometry-explore-r6-q11.txt` plus the T1 run log, with placeholder quote ids. Local: 3 files / 200 tests pass.
- CI: `ci` is red only because `ovd591-retention-qualification` hit the public.ecr.aws image-pull rate limit (`toomanyrequests: Data limit exceeded`). That's infra, not this change. All other checks pass.
CI: https://github.com/optomachina/Overdrafter/actions/runs/38828918939
