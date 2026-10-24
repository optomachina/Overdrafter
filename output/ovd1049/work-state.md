# OVD-1049 local implementation
Owner: Codex /root on Blaines-MacBook-Pro.local.
Worktree: /Users/blainewilson/Documents/Codex/2026-10-20/overnight/wt/ovd1049
Branch: fix/ovd1049-xometry-expired-session
Base: 5bc2343a9922d16108741f1ad972dcc8e452d0f6
Scope: current anonymous upload-prompt classification, finite blocking failures, synthetic regressions, recovery documentation.
Allowed: local edits and offline checks only; no commits, pushes, or live provider operations.
Completion: anonymous page with/without generic banner -> probe anonymous_quote_home and adapter login_required with valid finite terminal payload; authenticated dashboard remains accepted; requested checks pass.
Budget: 45 minutes, at most two code-repair rounds after checks; infra failures tracked separately.
Failure family: stale anonymous-page conjunction; missing declared terminalState; pre-classification network-idle wait.
Verification: worker tsc, root lint, probe/adapter/tools Vitest, live-release script Vitest; no live session qualification claimed.

## Final checkpoint (2026-10-22)
Implementation complete; final verification blocked by sandbox process inspection.
- Added anonymousUploadPromptSignals, preserving existing groups and auth proof. No DRIFT_SIGNAL_GROUPS or other DRIFT_* list exists in worker/src at this base.
- Probe: captcha/login/old anonymous rules retain precedence; absent authenticated dashboard proof plus prompt outranks generic errors. Generic errors still block authenticated-dashboard acceptance.
- Adapter: same classification, declared terminal states for blocking errors and prelaunch login failures. Initial network-idle wait removed; bounded hydration recognizes the prompt. Subsequent attempts cannot launch with invalidated snapshot ownership.
- Caller audit: detectBlockingState wraps classifier with finite VendorAutomationError; setQuantity uses classifier only in quote_configuration-constrained shadow recovery readiness and aborts on blockers.
- Root cause: failure contract requires payload.terminalState and does not infer it from error.code. Existing login/captcha/anti-detection errors omitted it. Stale all-signal anonymous rule misrouted current page, and initial networkidle wait could delay classification.
- Tests use three synthetic strings only. Two old fixture contexts were corrected so their unrelated email-gate and snapshot-teardown scenarios still reach the intended behavior.
- Independent read-only review (including final prelaunch delta): no actionable findings.

Commands on final working-tree source:
- cd worker && npx tsc --noEmit -p . : PASS (exit 0)
- npm run lint : PASS (exit 0)
- npx vitest run worker/src/xometryAuthProbe.test.ts worker/src/adapters/xometry.test.ts worker/src/tools : PASS, 21 files / 472 tests
- npx vitest run worker/src/adapters/providerAdapterContract.test.ts : PASS, 33 tests
- npx vitest run scripts/run-ovd419-live-release.test.mjs : FAIL due to sandbox spawn EPERM for ps at scripts/run-ovd419-live-release.mjs:381; 188 passed, 1 failed, 1 skipped. Release script unchanged by this patch. Direct /bin/ps also denied operation not permitted. No test weakening or bypass performed.
- git diff --check : PASS
Initial targeted runs exposed test setup issues, corrected in two rounds (evaluation factory/legacy fixture context, then checking adapter-owned state rather than the registry's copied configuration).
No live provider qualification performed. No commits or pushes. HEAD remains the base above.
Remaining action: rerun the release-script suite where its existing process-inspection permission is available.
