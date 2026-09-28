# Local sample plate demo (OVD-578)

This opt-in Windows development route builds one approved sample through the
existing SolidWorks 2022 session. It is not production JARVIS, phone/LAN access,
general CAD, a PDM release, or OVD-562 runtime/stop-observer qualification.

## Start

Install normal repository dependencies. On the approved workstation, run:

```powershell
./scripts/start-sample-plate.ps1 -BenchmarkRoot 'C:\Users\blain\Documents\Codex\2026-09-27\can-x20-2' -OutputRoot 'C:\Users\blain\AppData\Local\OverDrafter\sample-plate-ovd578'
```

The startup script requires exactly one existing SolidWorks process and free
port 8091; it never launches SolidWorks. Open the private `launch-url.txt` in
that output directory within ten minutes. It exchanges a one-use capability
for an HttpOnly, SameSite=Strict cookie and removes the URL fragment. The UI
uses `http://127.0.0.1:8091/dev/engineering/plate`. No hosted database is needed.

Enter **Build the sample plate**. The displayed recipe is 4×4×0.25 inches,
6061 Alloy, four native 1/4-20 UNC 2B through taps on a centered 3×3 inch square,
and R0.5-inch corners concentric with those holes. No temper beyond the native
material value is inferred. A reference to the sample means this fixed recipe;
modified or ambiguous recipes are rejected. The illustration is not a CAD preview.

## Boundaries and recovery

- Jev 1.13.0 selects one bounded action through the existing protected reader
  `.codex/skills/typesafe-ai/scripts/jev-windows.py`. The existing Credential
  Manager target is `Codex/TypeSafe/APIKey`; the app never reads or sends the key
  to the frontend. The native implementation never consumes model-generated code.
- The development plugin requires loopback, strict port and strict filesystem
  access. The private output root must be outside every Vite file allowlist.
  Exact Host/Origin and CSRF checks protect mutations. The generic benchmark
  HTTP bridge is neither started nor exposed.
- `attempts.jsonl` is flushed before native invocation. The exclusive permanent
  `native-attempt.lock` admits one native attempt per output workspace, including
  across restart. Same-ID requests return the old status; conflicts reject.
  The shim also takes a Windows named mutex against overlapping native shims.
- Error, timeout, lost reply and interrupted work are **unknown**, never success
  or automatic retry. Do not delete a lock, use another output root, or restart
  a native attempt to resolve uncertainty. Inspect its files/receipt and existing
  SolidWorks session first. This demo does not implement general cancellation
  or process-exit proof, and never kills the existing SolidWorks process.
- Only new owned documents are closed. The original active document is restored
  without rebuilding; the before/after document identity and dirty-state lists
  must match. Native and checker source hashes, helper hash and retained process
  identity are recorded. The shared helper itself is hash-pinned.
- Native output is saved and reopened; STEP is independently imported. Checks
  cover one valid solid, dimensions, complete face/cylinder census, analytical
  volume, hole/corner radii and positions, through geometry, native thread
  properties, material and document preservation. STEP has drill geometry;
  cosmetic thread metadata remains in SLDPRT, not helical thread solids.
- Only verified, hash-matching files can be downloaded through authenticated
  routes. The UI shows Jev round-trip latency, actual usage and estimated
  inference cost separately from native execution/check time. These are not
  autonomous-agent benchmark measurements or total engineering costs.

## Verification

```text
npx vitest run server/engineering/sample-plate.test.ts
C:/Python312/python.exe -m unittest discover -s scripts/native/sample-plate -p test_*.py
npm run typecheck
npm run lint
npm run build
npm run verify
```

Targeted tests cover auth/origin/CSRF, capability replay, conflicting recipe,
same-ID replay, cross-process contention, uncertain recovery, required checks,
extra/misplaced geometry and removed volume. Browser and real native evidence
are required in addition; synthetic checks alone do not qualify the live path.
Windows lacks the Unix `fcntl` and `/bin/sh` dependencies of some unrelated
repository gates; record those failures explicitly and use hosted Linux gates
for final integration. Never label a partial verify run successful.
