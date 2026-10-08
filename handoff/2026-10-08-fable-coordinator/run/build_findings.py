import json,subprocess,sys
R='f9348a2768088214be0febb5b08def3f40674e20'
S=sys.argv[1]
d=json.load(open(S+'/issues.json'))
cache={}
def line(f,n):
    if f not in cache: cache[f]=subprocess.run(['git','show',R+':'+f],capture_output=True,text=True,cwd='/home/user/Overdrafter').stdout.split('\n')
    return cache[f][n-1].strip()
FP='false_positive'
ev={
('scripts/ovd591-ci-fixture.mjs',119):(FP,'TABLES is a frozen array of six string-literal table names; sorted once so the expected list matches the catalog rows ordered by c.relname (type name, C collation) in an exact deepEqual admission check - determinism, not display.'),
('scripts/ovd591-ci-fixture.mjs',151):(FP,'RPCS is a frozen array of string-literal function signatures; sorted copy is the expected value for an exact deepEqual against catalog rows, an internal admission check with no user display.'),
('scripts/ovd591-ci-fixture.node-test.mjs',28):(FP,'Test fixture: [...RPCS] (string literals) sorted to build a synthetic catalog that must match admitCatalog\'s identical code-unit sort; same comparator on both sides.'),
('scripts/ovd591-ci-fixture.node-test.mjs',30):(FP,'Test fixture: RETENTION_TABLES is a string-literal array; sorted to mirror admitRetentionCatalog\'s identical default sort.'),
('scripts/ovd591-ci-fixture.node-test.mjs',31):(FP,'Test fixture: RETENTION_RPCS is a string-literal signature array; sorted to mirror admitRetentionCatalog\'s identical default sort.'),
('scripts/ovd591-retention-concurrency.node-test.mjs',228):(FP,'Test fixture: RETENTION_TABLES string literals sorted to satisfy admitRetentionCatalog, which applies the same default sort.'),
('scripts/ovd591-retention-concurrency.node-test.mjs',229):(FP,'Test fixture: RETENTION_RPCS string literals sorted to satisfy admitRetentionCatalog, which applies the same default sort.'),
('scripts/ovd591-retention-profile.mjs',40):(FP,'RETENTION_TABLES is a string-literal array; sorted copy is the exact expected value for catalog rows ordered by c.relname (C collation) - deterministic admission check.'),
('scripts/ovd591-retention-profile.mjs',45):(FP,'RETENTION_RPCS is a string-literal signature array; sorted copy is the exact expected value for a deepEqual admission check, no display.'),
('src/components/admin/OperationsStatusCard.tsx',65):('unsure','Contradicts the stated rationale: elements are strings (OperationsCategory enum ids) but the sort orders the Category <select> options shown to the admin, i.e. user display, not hashing/comparison. Behaviour is currently correct because every value is a lowercase-ASCII enum id and label() only swaps "_" for " " and capitalises the first letter, so code-unit order equals alphabetical label order. Fix: .sort((a, b) => label(a).localeCompare(label(b))) (display-only, safe); or resolve as false positive with a display-specific rationale.'),
('src/components/admin/OperationsStatusCard.tsx',66):('unsure','Contradicts the stated rationale: elements are strings (OperationsProvider | subsystem literal ids, never null because subsystem is required) but the sort orders the "Provider or subsystem" <select> options, i.e. user display. Correct today for the closed lowercase-ASCII id set (the "-" in cad-worker does not change order). Fix: .sort((a, b) => label(a).localeCompare(label(b))); or resolve as false positive with a display-specific rationale.'),
('worker/src/jev/choice.ts',24):(FP,'Object.keys() of a Record<string, number> (always string[]); sorted only to compare against [...options].sort() via JSON.stringify on line 30 - set equality, both sides use the same comparator.'),
('worker/src/jev/choice.ts',30):(FP,'options is string[]; sorted copy compared with the sorted keys on line 24 for exact set equality; locale-independent order is what that comparison needs.'),
('worker/src/providerCapabilityAttention.ts',112):(FP,'result is string[] of tokens already validated against /^\\.?[a-z0-9][a-z0-9_-]{0,31}$/i and lowercased; dedup+sort yields a canonical extension list for evidence comparison.'),
('worker/src/providerCapabilityAttentionStoreAdapter.ts',59):(FP,'Object.keys() is string[]; sorted inside canonical() to produce a key-order-independent canonical JSON string - exactly the hashing/determinism case; localeCompare would make it locale-dependent.'),
('worker/src/providerCapabilityRetention.ts',51):(FP,'keys come from Reflect.ownKeys and line 50 throws unless every key is a string; sorted to build a canonical key order in a defensive copy (determinism).'),
('worker/src/quoteIntelligence/quoteEvidence.ts',70):(FP,'flags is a Set<string> of fixed machine reason codes (e.g. "duplicate_id", `${basis}_basis`); sorted for a deterministic output array, not displayed text.'),
('e2e/quote-confirmation/network.ts',26):(FP,'pendingGate is typed Promise<void> | null; `if (this.pendingGate)` tests whether a gate is held (non-null), which is the intended guard against double-hold, not the promise\'s resolved value.'),
('e2e/quote-confirmation/network.ts',99):(FP,'`if (gate) await gate;` - gate is the Promise<void> | null captured on line 95; the condition checks presence and the body awaits it, so the promise is not being mistaken for a boolean.'),
('src/features/operations/operations-status-client.ts',21):('unsure','No functional defect (rejection is caught by .catch, any sync throw by the try), but the stated mechanism is wrong: per the WHATWG Streams spec ReadableStream.cancel() on a locked/errored stream returns a rejected promise and does not throw synchronously, so the try only matters for non-conforming implementations or a cancel() returning a non-promise. Fix: drop the try (`void body?.cancel().catch(() => undefined)`), or resolve with a corrected rationale ("defensive against non-conforming stream implementations").'),
('src/features/operations/operations-status-client.ts',84):('unsure','Same as line 21: reader.cancel() on a released/errored reader returns a rejected promise per spec rather than throwing, so the "synchronous throw on locked/errored stream" rationale is inaccurate; the try is redundant but harmless. Fix: remove the try around `void reader.cancel().catch(() => undefined)`, or resolve with a corrected rationale.'),
('docs/qa/customer-continuous-fixture.js',5):(FP,'File is a bare `async (page) => {...}` expression documented in its header as a Playwright CLI run-code function; only referenced by name from docs/qa/customer-continuous-fixture-2026-10-02.md, never imported or built.'),
('docs/qa/source-link-browser-check.js',1):(FP,'Bare async (page) => {...} Playwright CLI run-code expression; only referenced by name from docs/qa/customer-continuous-fixture-2026-10-02.md, never imported or built.'),
('docs/qa/source-link-browser-setup.js',2):(FP,'Bare async (page) => {...} Playwright CLI run-code expression; only referenced by name from docs/qa/customer-continuous-fixture-2026-10-02.md, never imported or built.'),
('scripts/ovd591-retention-qualification.mjs',16):(FP,'Line 13 `assert.match(container ?? \'\', /^ovd591-[a-z0-9-]+$/)` runs first in runRetentionQualification, before every exec that uses container (lines 40, 58, 66); the pattern cannot start with "-" so it cannot become a docker option; execFileSync/spawnSync are used with argv arrays and no shell option anywhere in the file.'),
('scripts/ovd591-sql-qualification.mjs',56):(FP,'Line 51 validates container against /^ovd591-[a-z0-9-]+$/ (and line 50 restricts transport to dblink|psql) before the run helper is defined and before every use (lines 83, 103, 112); no shell:true on the host. The only shell is `sh -c FIXTURE_PASSWORD_SESSION` inside the container with a constant script and positional args.'),
('scripts/check-compiled-worker-scope.mjs',13):(FP,'The script never creates or reads files in a shared temp dir; it only forwards the caller\'s TMPDIR to its npm/tsc/node children (Node drops the key when undefined), and its own output goes to a caller-chosen exclusive mkdirSync directory. Offline evidence script referenced only from scripts/fixtures/compiled-worker-scope.md.'),
('scripts/test-support/source-only-network.node-test.cjs',95):(FP,'Literal "/tmp/synthetic-only.sock" is a socket path passed to new net.Socket().connect() inside assert.throws(..., { code: "ERR_OFFLINE_TRIPWIRE" }); the tripwire must throw synchronously, nothing is created, read or written at that path.'),
}
s4036_note={
'scripts/check-compiled-worker-scope.mjs':'Offline compiled-worker evidence builder; referenced only by scripts/fixtures/compiled-worker-scope.md.',
'scripts/free-quote-psql-races.mjs':'CI qualification runner; referenced only by .github/workflows/free-quote-sql-qualification.yml and other scripts/.',
'scripts/ovd510-immutable-source.mjs':'Local replay helper; referenced only by scripts/ovd510-disposable-replay.mjs.',
'scripts/ovd510-immutable-source.node-test.mjs':'Node test building a throwaway git fixture repo; not referenced outside scripts/.',
'scripts/ovd591-psql-concurrency.mjs':'CI qualification runner; referenced by .github/workflows/*qualification.yml, docs/ and scripts/ only.',
'scripts/ovd591-retention-concurrency.mjs':'CI qualification runner; referenced by .github/workflows/*qualification.yml and scripts/ only.',
'scripts/ovd591-retention-qualification.mjs':'CI qualification runner; referenced by .github/workflows/ci.yml and scripts/ only.',
'scripts/ovd591-sql-qualification.mjs':'CI qualification runner; referenced by .github/workflows/*qualification.yml, docs/ and scripts/ only.',
'scripts/ovd591-sql-qualification.node-test.mjs':'Node test; explicitly passes env { PATH: process.env.PATH, ... } to the child; not referenced by production code.',
'scripts/ovd591-workflow-context.node-test.mjs':'Node test; referenced by .github/workflows/ovd591-*qualification.yml only.',
'scripts/run-supabase-policy-tests.mjs':'CI/local policy-test runner; referenced only by .github/workflows/ci.yml.',
}
out=[]
for i in sorted(d['issues'],key=lambda x:(x['rule'].split(':')[1],x['component'],x.get('line',0))):
    f=i['component'].split(':',1)[1]; n=i['line']; rule=i['rule']
    if rule.endswith('S4036'):
        verdict='accept'; e=f'Resolves an unqualified binary via the runner\'s PATH in a dev/CI-only script. {s4036_note[f]} git grep finds no reference from api/, server/, shared/, src/, worker/ or supabase/functions/.'
    else:
        verdict,e=ev[(f,n)]
    res={'false_positive':'False Positive','accept':'Accept','unsure':'Hold - do not resolve until rationale corrected or code changed','REAL':'Fix in code'}[verdict]
    out.append({'key':i['key'],'rule':rule,'type':i['type'],'severity':i['severity'],'location':f'{f}:{n}','message':i['message'],'source_line':line(f,n),'verdict':verdict,'evidence':e,'proposed_resolution':res})
counts={}
for o in out: counts[o['verdict']]=counts.get(o['verdict'],0)+1
doc={'pr':564,'branch':'codex/recovered-release-free-safety-20261003','head':R,'sonar_query_total':d['total'],'counts':counts,'issues':out}
json.dump(doc,open(S+'/findings/sonar-564-bugvuln-verification.json','w'),indent=2)
esc=lambda s:s.replace('|','\\|')
md=['# PR 564 Sonar BUG/VULNERABILITY verification','',f'Head `{R}`. Sonar returned {d["total"]} open issues; each site was checked against `git show` of that head.','']
md+=['## Counts','']+[f'- {k}: {v}' for k,v in sorted(counts.items())]+['']
bad=[o for o in out if o['verdict'] in ('REAL','unsure')]
md+=['## REAL / unsure (resolve these first)','']
for o in bad: md.append(f'- `{o["key"]}` {o["rule"]} `{o["location"]}` ({o["verdict"]}): {o["evidence"]}')
if not bad: md.append('- none')
md+=['','## All issues','','| # | key | rule | location | source line | verdict | evidence | proposed resolution |','|---|---|---|---|---|---|---|---|']
for k,o in enumerate(out,1):
    src=o['source_line'];src=src if len(src)<=140 else src[:137]+'...'
    md.append(f'| {k} | `{o["key"]}` | {o["rule"]} | `{o["location"]}` | `{esc(src)}` | {o["verdict"]} | {esc(o["evidence"])} | {o["proposed_resolution"]} |')
open(S+'/findings/sonar-564-bugvuln-verification.md','w').write('\n'.join(md)+'\n')
print(counts,len(out))
