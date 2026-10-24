import fs from "node:fs";
import * as R from "/workspace/qa-batch/repo/scripts/provider-registry.mjs";
import { validateProviderManifest } from "/workspace/qa-batch/repo/scripts/provider-manifest.mjs";
const base = JSON.parse(fs.readFileSync("provider-integrations/provider-registry.v1.json","utf8"));
const clone = () => structuredClone(base);
const get = (d,k) => d.providers.find(p=>p.key===k);
const sec = (d,k) => get(d,k).sessionSecrets[0];
function t(name, fn, expectFail=true){
  const d=clone(); fn(d); let err=null;
  try { R.validateProviderRegistry(d); } catch(e){ err=e.message; }
  const ok = (err!==null)===expectFail;
  console.log(`[${ok?"OK":"UNEXPECTED"}] ${name}: ${err?"REJECT "+err.slice(0,140):"ACCEPT"}`);
}
const JWT="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk", AKIA="AKIAIOSFODNN7EXAMPLE",
 GHP="ghp_"+"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", GHO="gho_"+"Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2",
 SK="sk-"+"proj4f8a9B2c7D1e6F3g5H0iJkLmNoPq", RND="q7Rz2Kp9Xv4Lm8Nw3Bt6Yc1Hd5Fg0Js2Ua";
t("baseline", ()=>{}, false);
t("suffix missing", d=>sec(d,"fictiv").secretNameEnv="FICTIV_STORAGE_STATE");
t("suffix lowercase", d=>sec(d,"fictiv").secretNameEnv="FICTIV_STORAGE_STATE_secret_name");
t("reserved GOOGLE_*_SECRET_NAME", d=>sec(d,"fictiv").secretNameEnv="GOOGLE_CLOUD_SECRET_NAME");
t("reserved SUPABASE_SERVICE_ROLE_SECRET_NAME", d=>sec(d,"fictiv").secretNameEnv="SUPABASE_SERVICE_ROLE_SECRET_NAME");
t("reserved scraped OPENAI_API_KEY_SECRET_NAME", d=>sec(d,"fictiv").secretNameEnv="OPENAI_API_KEY_SECRET_NAME");
t("reserved scraped ANTHROPIC_API_KEY_SECRET_NAME", d=>sec(d,"fictiv").secretNameEnv="ANTHROPIC_API_KEY_SECRET_NAME");
t("reserved mountEnv WORKER_MODE", d=>sec(d,"fictiv").mountEnv="WORKER_MODE");
t("reserved mountEnv SUPABASE_SERVICE_ROLE_KEY", d=>sec(d,"fictiv").mountEnv="SUPABASE_SERVICE_ROLE_KEY");
t("reserved mountEnv IFS", d=>sec(d,"fictiv").mountEnv="IFS");
t("cross-provider secretNameEnv", d=>sec(d,"weerg").secretNameEnv="QUICKPARTS_STORAGE_STATE_SECRET_NAME");
t("cross-provider mountPath (same path, diff name)", d=>sec(d,"weerg").mountPath="/var/secrets/quickparts-storage-state/storage-state.json");
t("cross-provider mountEnv", d=>{const s=sec(d,"weerg"); delete s.mountPath; s.mountEnv="FICTIV_STORAGE_STATE_JSON";});
t("same provider two secrets same name", d=>get(d,"weerg").sessionSecrets.push({...sec(d,"weerg")}));
t("rmfg live, no secrets, egress omitted", d=>{const p=get(d,"rmfg"); p.liveAdapter=true; delete p.egress;});
t("rmfg live, no secrets, egress none, no justif", d=>{get(d,"rmfg").liveAdapter=true;});
t("rmfg live, optional-only secret, no justif", d=>Object.assign(get(d,"rmfg"),{liveAdapter:true,sessionSecrets:[{secretNameEnv:"RMFG_STORAGE_STATE_SECRET_NAME",mountEnv:"RMFG_STORAGE_STATE_JSON",requiredWhenListed:false}]}));
t("rmfg live, justif ok, egress omitted", d=>{const p=get(d,"rmfg"); Object.assign(p,{liveAdapter:true,sessionlessJustification:"public API, no session needed at all"}); delete p.egress;});
t("justif empty", d=>Object.assign(get(d,"rmfg"),{liveAdapter:true,sessionlessJustification:""}));
t("justif 30 spaces", d=>Object.assign(get(d,"rmfg"),{liveAdapter:true,sessionlessJustification:" ".repeat(30)}));
t("justif whitespace mix 27", d=>Object.assign(get(d,"rmfg"),{liveAdapter:true,sessionlessJustification:"\t\n ".repeat(9)}));
t("justif 5 chars padded by 20 spaces", d=>Object.assign(get(d,"rmfg"),{liveAdapter:true,sessionlessJustification:"ok   "+" ".repeat(20)}));
t("justif non-string 123", d=>Object.assign(get(d,"rmfg"),{liveAdapter:true,sessionlessJustification:123}));
t("justif on non-live", d=>Object.assign(get(d,"rmfg"),{sessionlessJustification:"a real reason for listing"}));
t("manualDeploy string 'true'", d=>sec(d,"fictiv").manualDeploy="true");
t("manualDeploy:true on fictiv required secret (other provider)", d=>sec(d,"fictiv").manualDeploy=true, true);
t("manualDeploy:true on new rmfg optional secret", d=>Object.assign(get(d,"rmfg"),{liveAdapter:true,sessionlessJustification:"reviewed sessionless reason here",sessionSecrets:[{secretNameEnv:"RMFG_STORAGE_STATE_SECRET_NAME",mountEnv:"RMFG_STORAGE_STATE_JSON",requiredWhenListed:false,manualDeploy:true}]}), true);
for (const [n,v] of Object.entries({JWT,AKIA,ghp:GHP,gho:GHO,sk:SK,random:RND})) {
  t(`planted ${n} in justification`, d=>get(d,"xometry").sessionlessJustification="reviewed reason "+v);
  t(`planted ${n} as mountEnv`, d=>sec(d,"fictiv").mountEnv=v);
  t(`planted ${n} as extra field value`, d=>get(d,"rmfg").note=v);
}
for (const v of ["QUICKPARTS_PORTAL_STORAGE_STATE_SECRET_NAME","WEERG_EU_STORAGE_STATE_SECRET_NAME"])
  t(`FP legit name ${v}`, d=>sec(d,"weerg").secretNameEnv=v, false);
t("FP legit mountPath long", d=>sec(d,"weerg").mountPath="/var/secrets/weerg-eu-portal-storage-state/storage-state.json", false);
t("FP justification prose w/ 'task-' 'sky-' words", d=>get(d,"xometry").sessionlessJustification="Xometry uses the deploy script's snapshot path; see risk-skeleton notes.", false);
// detector unit
for (const v of ["sk-learn is a library name here","ghp_short","eyJ","AKIAEXAMPLE","/var/secrets/x-y/storage-state.json","XOMETRY_STORAGE_STATE_SECRET_NAME","https://www.rmfg.com/","sheet_metal_fabrication","#6b738f", "a8f5f167f44f4964e6c998dee827110c", "dGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZyB0aGF0", "Q7rZ2kP9xV4lM8nW3bT6yC1hD5fG0jS2uA/abc"])
  console.log(`  detector ${JSON.stringify(v)} -> ${R.looksLikeSecretValue(v)}`);
// manifests
const m0 = JSON.parse(fs.readFileSync("provider-integrations/rmfg/manifest.v1.json","utf8"));
for (const [n,v] of Object.entries({JWT,AKIA,ghp:GHP,sk:SK,random:RND})) {
  const m=structuredClone(m0); m.displayName="RMFG "+v; let err=null;
  try{ validateProviderManifest(m); }catch(e){err=e.message}
  console.log(`[${err?"OK":"UNEXPECTED"}] manifest displayName ${n}: ${err?"REJECT "+err.slice(0,120):"ACCEPT"}`);
  const m2=structuredClone(m0); m2.official.urls=["https://www.rmfg.com/?t="+v]; err=null;
  try{ validateProviderManifest(m2); }catch(e){err=e.message}
  console.log(`[${err?"OK":"UNEXPECTED"}] manifest url ${n}: ${err?"REJECT "+err.slice(0,120):"ACCEPT"}`);
}
