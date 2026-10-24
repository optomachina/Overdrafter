import { touchesProviderGoLivePaths as t, validatePrBody as v } from "/workspace/qa-batch/wt658/scripts/validate-pr-body.mjs";
const paths = {
 env:["worker/src/providerDispatchEnvelope.ts"], mig:["A\tsupabase/migrations/20261012000000_x_reviewed_dispatch_envelope.sql"],
 manifest:["M\tprovider-integrations/fictiv/manifest.v1.json"], registry:["provider-integrations/provider-registry.v1.json"],
 renameOut:["R100\tprovider-integrations/fictiv/manifest.v1.json\tdocs/old.json"], renameOutEnv:["D\tworker/src/providerDispatchEnvelope.ts","A\tworker/src/x.ts"],
 fixture:["test-fixtures/provider-dispatch-envelope/v1.json"], unrelated:["src/App.tsx"],
 near1:["worker/src/providerDispatchEnvelope.test.ts"], near2:["provider-integrations-old/x.json"], near3:["supabase/migrations/2026_reviewed_dispatch_envelope.sql.bak"], near4:["docs/worker/src/providerDispatchEnvelope.ts"],
 GAP_genReg:["worker/src/generated/providerRegistry.ts"], GAP_genCat:["worker/src/generated/provider-catalog.ts"], GAP_genSecrets:["worker/scripts/generated/provider-secrets.sh"], GAP_admMig:["supabase/migrations/20261004130000_ovd628_generic_admission_nowait.sql"], GAP_deploy:["worker/scripts/deploy-cloud-run.sh"],
};
for (const [k,p] of Object.entries(paths)) console.log("path", k, t(p));
const base = `## Summary\nS\n## Problem\nP\n## Scope\nS\n## Verification\n\`\`\`bash\nnpm test\n\`\`\`\n- [x] passed\n## Tests\nT\n## Migration notes\n- [x] No migration impact\n## Rollback / risk notes\nR\n## Documentation\n- [x] Docs updated\n`;
const items = ["provider:check green","envelope reviewed by a named reviewer","approved admission revision","automatic_quote_collection rollout","worker adapter and Secret Manager secret","stable egress verified","certification run evidence","rollback/disable steps rehearsed"];
const good = i => `- [x] ${i} — Evidence: https://example.com/run/1`;
const mk = (fn) => base + "## Provider go-live\n" + items.map((it,i)=>fn(it,i)).join("\n") + "\n";
const C = ["M\tworker/src/providerDispatchEnvelope.ts"];
const run = (k,b)=>{const r=v(b,{changedFiles:C}); console.log("body",k,r.ok?"PASS":"FAIL", r.ok?"":r.errors.slice(0,2).join(" | "));};
run("allGood", mk(good));
for (const na of ["N/A: x","N/A:    ","N/A: n/a","N/A: TODO"]) run("tickedNA["+na+"]", mk((it,i)=> i==5?`- [x] ${it} ${na} https://example.com/a`:good(it)));
run("tickedNA_real", mk((it,i)=> i==5?`- [x] ${it} N/A: provider uses customer-hosted static IP, see https://example.com/a`:good(it)));
run("uncheckedNA_real", mk((it,i)=> i==5?`- [ ] ${it} N/A: provider uses customer-hosted static IP https://example.com/a`:good(it)));
run("admissionNA", mk((it,i)=> i==2?`- [x] ${it} N/A: not needed for this provider at all https://example.com/a`:good(it)));
run("evidence_x", mk((it,i)=> i==0?`- [x] ${it} Evidence: x`:good(it)));
run("evidence_TODO", mk((it,i)=> i==0?`- [x] ${it} Evidence: TODO`:good(it)));
run("oneLineAll", base+"## Provider go-live\n- [x] "+items.join(" ")+" https://example.com/x\n");
run("fencedHeading", base.replace("## Summary\nS\n","")+"```\n## Summary\nS\n## Provider go-live\n"+items.map(good).join("\n")+"\n```\n");
run("fencedGoLive", base+"```\n## Provider go-live\n"+items.map(good).join("\n")+"\n```\n");
run("weakEvidence_word_slash", mk((it,i)=> i==0?`- [x] ${it} and/or done`:good(it)));
run("weakEvidence_hexword", mk((it,i)=> i==0?`- [x] ${it} deadbeef`:good(it)));
run("weakEvidence_git", mk((it,i)=> i==0?`- [x] ${it} git status`:good(it)));
console.log("noGoLiveSkip", v(base,{changedFiles:["test-fixtures/provider-dispatch-envelope/v1.json"]}).ok);
for (const na of ["N/A: x","N/A:    ","N/A: n/a","N/A: TODO"]) run("evidenceFirst["+na+"]", mk((it,i)=> i==5?`- [x] ${it} https://example.com/a ${na}`:good(it)));
run("NA_x_with_path_after", mk((it,i)=> i==5?`- [x] ${it} N/A: x docs/a.md`:good(it)));
run("NA_x_alone", mk((it,i)=> i==5?`- [x] ${it} N/A: x`:good(it)));
