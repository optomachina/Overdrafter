#!/usr/bin/env bash
# usage: argv.sh <repo> ; prints argv + exit + stdout per scenario
R=$1; out=""
run(){ name=$1; shift; d=$(mktemp -d); cat > $d/g <<G
#!/usr/bin/env bash
printf '%s\x1f' "\$@" >> $d/calls; printf '\n' >> $d/calls
[[ "\$1" == projects ]] && { echo 123456789012; exit 0; }
[[ "\$1" == storage ]] && { echo '{"projectNumber":"123456789012","iamConfiguration":{"publicAccessPrevention":"enforced","uniformBucketLevelAccess":{"enabled":true}},"versioning":{"enabled":true},"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}},{"action":{"type":"Delete"},"condition":{"isLive":true}}]}}'; exit 0; }
exit 0
G
chmod +x $d/g
echo "=== $name"; env -i PATH=$PATH HOME=$HOME GOOGLE_CLOUD_PROJECT=synthetic-project SUPABASE_URL=https://s.supabase.co GCLOUD_BIN=$d/g "$@" bash $R/worker/scripts/deploy-cloud-run.sh 2>&1 | sed "s#$d#D#g"; echo "exit ${PIPESTATUS[0]}"; sed "s#$d#D#g" $d/calls 2>/dev/null | tr '\037' ' '; }
SN="XOMETRY_PROFILE_SNAPSHOT_BUCKET=b XOMETRY_PROFILE_SNAPSHOT_OBJECT=p/x.tgz"
EG="CLOUD_RUN_MIN_INSTANCES=0 CLOUD_RUN_MAX_INSTANCES=1 CLOUD_RUN_NETWORK=n CLOUD_RUN_SUBNET=s CLOUD_RUN_VPC_EGRESS=all-traffic CLOUD_RUN_SERVICE_ACCOUNT=w@p.iam.gserviceaccount.com XOMETRY_BROWSER_ENGINE=camoufox"
S="FICTIV_STORAGE_STATE_SECRET_NAME=fs QUICKPARTS_STORAGE_STATE_SECRET_NAME=qs WEERG_STORAGE_STATE_SECRET_NAME=ws"
run simulate
run live-x WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry $SN
run live-x-secret WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry XOMETRY_STORAGE_STATE_SECRET_NAME=xs
run live-all WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry,fictiv,quickparts,weerg $SN $S
run live-all-egress WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry,fictiv,quickparts,weerg $SN $S $EG
run live-xq-egress WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry,quickparts $SN $S $EG
run bad-order-egress WORKER_MODE=live WORKER_LIVE_ADAPTERS=fictiv,xometry $SN $S $EG
run fictiv-only WORKER_MODE=live WORKER_LIVE_ADAPTERS=fictiv $S
run missing-secret WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry,weerg $SN
run unknown WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry,rmfg $SN
run dup WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry,xometry $SN
run empty WORKER_MODE=live WORKER_LIVE_ADAPTERS=
run fictiv-no-secret WORKER_MODE=live WORKER_LIVE_ADAPTERS=xometry,fictiv XOMETRY_STORAGE_STATE_SECRET_NAME=xs
