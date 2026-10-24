#!/bin/bash
cd /workspace/qa660/repo
L=/workspace/qa660/qa-run-2.log
E=worker/src/providerDispatchEnvelope.ts
reset(){ git reset -q --hard da2fb73; git clean -fdq -- docs worker test-fixtures; }
run(){ # name expect cmd
  reset; eval "$3"; out=$(node scripts/provider-check.mjs 2>&1); rc=$?
  rp=$(echo "$out" | tr -d '\n ' | grep -o '"reviewedProviders":\[[^]]*\]')
  res=$([ "$2" = fail ] && { [ $rc -ne 0 ] && echo PASS || echo FAIL; } || { [ $rc -eq 0 ] && echo PASS || echo FAIL; })
  { echo "### CASE [$1] expect=$2 rc=$rc => $res"; echo "$out" | grep -E 'provider:check:|Error|must|reviewed' | grep -v '^ *"' | head -6; [ -n "$rp" ] && echo "  $rp"; } | tee -a $L
  reset
}
echo "===== MUTATION CASES $(date) head=$(git rev-parse HEAD)" >> $L
run baseline pass ":"
run "orig bypass: delete quickparts doc" fail "git rm -q docs/workflows/ovd674-quickparts-live-readiness.md; grep -c -i quickparts docs/workflows/ovd675-weerg-live-readiness.md"
for p in fictiv quickparts weerg; do
 run "delete $p fixture TS" fail "rm worker/test-support/${p}DispatchFixture.ts"
 run "delete $p fixture JSON" fail "rm test-fixtures/provider-dispatch-envelope/${p}-v1.json"
 run "delete $p readiness doc" fail "rm docs/workflows/ovd67*-${p}-live-readiness.md"
done
run "delete quickparts default-deny test" fail "rm worker/src/adapters/quickpartsProductionPortal.test.ts"
run "delete weerg default-deny test" fail "rm worker/src/adapters/weergProductionPortal.test.ts"
run "weerg doc gone, quickparts doc mentions weerg" fail "rm docs/workflows/ovd675-weerg-live-readiness.md; echo 'weerg weerg-live-readiness weerg' >> docs/workflows/ovd674-quickparts-live-readiness.md"
run "weerg test = quickparts test (mentions weerg in comment)" fail "cp worker/src/adapters/quickpartsProductionPortal.test.ts worker/src/adapters/weergProductionPortal.test.ts; echo '// weerg weerg-quote-envelope' >> worker/src/adapters/weergProductionPortal.test.ts"
run "weerg test: vendor swapped to quickparts" fail "sed -i 's/vendor: \"weerg\"/vendor: \"quickparts\"/' worker/src/adapters/weergProductionPortal.test.ts; grep -c 'vendor: \"quickparts\"' worker/src/adapters/weergProductionPortal.test.ts"
run "weerg test: registrar call removed (import kept)" fail "sed -i 's/^\(\s*\)registerProductionPortalAuthorizationRefusals(/\1void (/' worker/src/adapters/weergProductionPortal.test.ts"
run "weerg fixture TS = quickparts fixture + weerg comment" fail "cp worker/test-support/quickpartsDispatchFixture.ts worker/test-support/weergDispatchFixture.ts; echo '// weerg-v1.json weerg' >> worker/test-support/weergDispatchFixture.ts"
run "envelopes: single quotes" pass "sed -i '/REVIEWED_PROVIDER_DISPATCH_ENVELOPES:/,/^];/ s/\"/'\"'\"'/g' $E; sed -n '/REVIEWED_PROVIDER_DISPATCH_ENVELOPES:/,/^];/p' $E | grep -c \"'\""
run "envelopes: separate variable" pass "sed -i 's/^export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES: readonly ReviewedProviderDispatchEnvelope\[\] = \[/const _REV: readonly ReviewedProviderDispatchEnvelope[] = [/' $E; echo 'export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = _REV;' >> $E"
run "envelopes: spread of separate array" pass "sed -i 's/^export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES: readonly ReviewedProviderDispatchEnvelope\[\] = \[/const _REV: readonly ReviewedProviderDispatchEnvelope[] = [/' $E; echo 'export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = [..._REV];' >> $E"
run "envelopes: weerg entry via spread object" pass "python3 - <<'P'
import re;f='$E';s=open(f).read()
i=s.index('REVIEWED_PROVIDER_DISPATCH_ENVELOPES:');j=s.index('provider: \"weerg\"',i);k=s.rindex('{',i,j)
s=s[:k]+'{ ...WEERG_SPREAD_ENTRY },\n  '+s[k:]
s+='\nconst WEERG_SPREAD_ENTRY = { provider: \"weerg\", id: \"weerg-quote-envelope\", version: 1, requiredAdmission: \"generic_dispatch\" } as const;\n'
open(f,'w').write(s)
P"
run "envelope source file deleted" fail "rm $E"
run "envelope export renamed" fail "sed -i 's/^export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES:/export const OTHER_NAME:/' $E"
run "default-deny call only in dead code (weerg)" fail "sed -i 's/^\(\s*\)registerProductionPortalAuthorizationRefusals(\(.*\));/\1if (false) registerProductionPortalAuthorizationRefusals(\2);/' worker/src/adapters/weergProductionPortal.test.ts; grep -n 'if (false)' worker/src/adapters/weergProductionPortal.test.ts"
run "weerg readiness doc replaced with 1 char" fail "echo x > docs/workflows/ovd675-weerg-live-readiness.md"
reset
