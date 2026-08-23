# OVD-410 Stable Xometry Egress

Last updated: August 23, 2026

This workflow provisions and verifies the single cost-governed outbound path
owned by `OVD-410`. It does not authorize Xometry login, profile rotation,
snapshot replacement, authentication-Job execution, CAD upload, quote creation,
ordering, or the separate `OVD-408` production release.

As verified on August 23, 2026, the fixed resources below exist, the worker and
authentication Job share the current immutable worker/probe image on the same
all-traffic path, and the sanitized live verifier passes. One stale-image probe
failed closed with `authenticated_dashboard_not_confirmed` before the current
runtime was deployed. The first current-image replacement then failed closed
once with generic `probe_failed`; it used one task and zero retries, performed
no file selection or user interaction, and left the snapshot object unchanged.
The deployed generic envelope does not identify the internal failure stage.
The checked-in follow-up adds only an allowlisted `failureStage` classification
without low-level diagnostics; deploy and reverify it before requesting another
probe. The independent second probe has not run, so source-network binding and
repeatable hosted authentication remain unproven.

## Fixed production contract

| Resource | Required value |
| --- | --- |
| Project | `overdrafter-worker-9133` |
| Region | `us-west1` |
| Network | `overdrafter-xometry-egress` |
| Subnet | `overdrafter-xometry-egress-us-west1` |
| Subnet range | `10.81.0.0/26` |
| Reserved address | `overdrafter-xometry-egress-ip` |
| Reserved-address resource ID | `7266654960671511103` |
| Router | `overdrafter-xometry-egress-router` |
| Public NAT | `overdrafter-xometry-egress-nat` |
| Worker service | `overdrafter-cad-worker` |
| Authentication Job | `overdrafter-xometry-auth-probe` |
| Runtime service account | `overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com` |
| Temporary recovery VM | `overdrafter-xometry-auth-recovery` in `us-west1-b` |
| Recovery service account | `overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com` |
| Recovery firewall rule | `overdrafter-xometry-auth-recovery-iap` |
| Recovery image repository | `cloud-run-source-deploy` (`roles/artifactregistry.reader` only) |
| Temporary access API | `iap.googleapis.com` (restored to disabled after teardown) |

The `/26` custom subnet is the smallest supported Direct VPC egress range. The
subnet has Private Google Access enabled. Public NAT covers only that subnet,
uses exactly one manually reserved Premium IPv4 address, and records errors
only. Never paste the raw address into Linear, application logs, screenshots,
or ordinary evidence.

## Mandatory containment preflight

Before any change:

1. Confirm the `OVD-410` High-complexity and cloud-cost override is recorded.
2. Confirm billing self-service and every commercial rollout control are off
   using [Commercial Rollout Controls](commercial-rollout-controls.md).
3. Confirm zero queued or running vendor tasks and no active Cloud Run Job
   execution.
4. Record the current service revision, Job configuration, snapshot generation
   and size, and service/Job/project public-IAM result. Before initial
   provisioning, record the absence of VPC annotations. After provisioning,
   require the exact fixed network, subnet, and all-traffic annotations instead;
   absence is then rollback state, not a passing preflight. Do not record
   environment values, account identifiers, profile data, or a raw address.
5. Confirm the installed Google Cloud CLI exposes `--network`, `--subnet`, and
   `--vpc-egress` for `gcloud run jobs deploy`, plus Cloud Run service
   `describe` and `replace`. The configuration-only service helper uses a
   sanitized manifest because the installed service-update command does not
   expose the Direct VPC flags.

Stop if any containment check fails or the network state differs from the phase
being performed. Do not enable rollout to test networking.

## Provision the cost-bearing path

Create only the fixed resources above. Every command is intentionally explicit;
the ordinary worker deployment script never creates or deletes infrastructure.

```bash
gcloud services enable compute.googleapis.com \
  --project overdrafter-worker-9133

gcloud services enable cloudresourcemanager.googleapis.com \
  --project overdrafter-worker-9133

gcloud services enable networkconnectivity.googleapis.com \
  --project overdrafter-worker-9133

gcloud compute networks create overdrafter-xometry-egress \
  --project overdrafter-worker-9133 \
  --subnet-mode=custom \
  --bgp-routing-mode=regional

gcloud compute networks subnets create overdrafter-xometry-egress-us-west1 \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --network overdrafter-xometry-egress \
  --range 10.81.0.0/26 \
  --enable-private-ip-google-access

gcloud compute addresses create overdrafter-xometry-egress-ip \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --network-tier PREMIUM

gcloud compute routers create overdrafter-xometry-egress-router \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --network overdrafter-xometry-egress

gcloud compute routers nats create overdrafter-xometry-egress-nat \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --router overdrafter-xometry-egress-router \
  --nat-custom-subnet-ip-ranges overdrafter-xometry-egress-us-west1:ALL \
  --nat-external-ip-pool overdrafter-xometry-egress-ip \
  --enable-logging \
  --log-filter ERRORS_ONLY
```

If any named resource already exists, stop and inspect it. Do not adopt, mutate,
or replace an existing resource merely because its name matches.

## Bind without shipping unrelated worker code

The configuration-only service script preserves the currently deployed image;
it does not build from the working tree and therefore does not deploy the
separately gated `OVD-408` worker revision. The Job script resolves and preserves
its currently deployed image, updates configuration, and never uses
`--execute-now`. Both replacement manifests retain Cloud Run's `resourceVersion`
so a stale service or Job update fails instead of overwriting a concurrent
deployment. Both helpers reject any target outside the checked-in production
contract, and any post-dispatch client failure is an ambiguous outcome that
requires the read-only verifier before retry.

```bash
GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
CLOUD_RUN_REGION=us-west1 \
CLOUD_RUN_SERVICE_ACCOUNT=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
CLOUD_RUN_NETWORK=overdrafter-xometry-egress \
CLOUD_RUN_SUBNET=overdrafter-xometry-egress-us-west1 \
CLOUD_RUN_VPC_EGRESS=all-traffic \
XOMETRY_PROFILE_SNAPSHOT_BUCKET=<current-private-snapshot-bucket> \
XOMETRY_PROFILE_SNAPSHOT_OBJECT=<current-profile-snapshot-object> \
worker/scripts/configure-xometry-auth-probe-job.sh

GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
CLOUD_RUN_REGION=us-west1 \
CLOUD_RUN_SERVICE_ACCOUNT=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
CLOUD_RUN_NETWORK=overdrafter-xometry-egress \
CLOUD_RUN_SUBNET=overdrafter-xometry-egress-us-west1 \
CLOUD_RUN_VPC_EGRESS=all-traffic \
node scripts/configure-xometry-worker-egress.mjs
```

The worker update explicitly preserves `WORKER_MODE=live`,
`WORKER_LIVE_ADAPTERS=xometry`, trace capture off, scale-to-zero, max instances
one, and concurrency one. The Job update pins the bounded no-upload command,
replaces its environment with the Camoufox snapshot allowlist, clears secret
bindings, and preserves one task, parallelism one, zero retries, and the worker
service account. Resolve the existing snapshot identifiers in a protected
operator session; do not paste their values into ordinary evidence.

## Read-only verification

Run the verifier before any profile or provider operation:

```bash
GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
CLOUD_RUN_REGION=us-west1 \
CLOUD_RUN_SERVICE_ACCOUNT=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
CLOUD_RUN_NETWORK=overdrafter-xometry-egress \
CLOUD_RUN_SUBNET=overdrafter-xometry-egress-us-west1 \
CLOUD_RUN_SUBNET_RANGE=10.81.0.0/26 \
CLOUD_RUN_ROUTER=overdrafter-xometry-egress-router \
CLOUD_RUN_NAT=overdrafter-xometry-egress-nat \
CLOUD_RUN_NAT_ADDRESS=overdrafter-xometry-egress-ip \
CLOUD_RUN_NAT_ADDRESS_ID=7266654960671511103 \
npm run verify:xometry-egress
```

The verifier reads only bounded Cloud Run, service/Job/project IAM, VPC, subnet,
route, router, NAT, mapping, address, and completed-Job metadata. It proves the
ready revision receives all traffic, the service and Job retain the same
immutable image and snapshot/browser identity, the governed address resource
is in use, no competing route or active execution is present, and the fixed
regional `/26` IPv4-only subnet contract holds. It emits stable control codes,
not resource values or the raw address. A pass proves configuration only; it
does not prove that Xometry binds the authenticated session to source network
identity.

The configuration verifier does not inspect executable code inside that shared
image. Before authorizing probe one, require the retained image to contain the
current no-upload probe contract: verified page transport guards, explicit
network activation only after those guards are installed, and bounded dashboard
classifier polling. The August 23, 2026 retained image predates those controls
and is not eligible for another probe. The merged current worker/probe runtime
was subsequently deployed to both governed resources and the quiescent verifier
passed. Do not treat a shared image as proof of the current executable contract
unless its deployed digest is known to contain those controls.

A source deployment creates a temporary Direct VPC/NAT mapping while Cloud Run
starts and validates the new revision, even with minimum instances set to zero.
The ordinary verifier must fail closed until that mapping drains. On August 23,
2026, the deployment mapping drained about fifteen minutes after revision
creation. Observe only the sanitized mapping count, do not force a second
revision or scale mutation to accelerate teardown, and rerun the full verifier
once after the count reaches zero.

After a pass, recheck every rollout and billing control, zero queued/running
work, snapshot generation and size, private invocation, service scaling, Job
retry controls, and the retained image identity. Provider work remains blocked.

Every top-level `probe_failed` result must include an allowlisted
`failureStage`. The stage may identify only configuration, snapshot restore,
browser launch, bounded-probe setup, guard setup or verification, network
activation, navigation/inspection, operation timeout, network re-isolation,
context cleanup, or unknown. Never emit caught errors, paths, profile metadata,
provider content, or raw browser diagnostics. A generic failure from an older
deployed image is containment evidence only and is not sufficient to choose a
repair or authorize another retry.

## Exact-runtime recovery through the fixed path

The earlier local recovery container proved the production image and the fixed
Cloud NAT deployment proved the network path, but those two independent facts
do not prove that an interactive login used the fixed source network. OVD-410's
provider proof therefore requires one short-lived private Compute Engine host
on the exact governed subnet. The host runs the immutable worker image without
an external address and uses an IAP-only SSH tunnel for the localhost display.
Its dedicated service account can only pull from the worker Artifact Registry
repository; it cannot read or write the profile bucket, invoke Cloud Run, or
access Supabase.

Creating the service account, repository binding, firewall rule, VM, or logging
in to Xometry is a separately authorized, cost-bearing operation. Do not run
this section under a general deployment or probe approval. Before provisioning,
repeat the mandatory containment preflight, require the temporary resources to
be absent, and resolve the retained immutable image without printing it. Run
all blocks in this section from the same dedicated operator shell so the
recorded preflight state remains available; a missing variable must stop the
ceremony rather than be reconstructed from memory:

```bash
set -euo pipefail

OVD410_WORKER_IMAGE="$(gcloud run services describe overdrafter-cad-worker \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --format='value(spec.template.spec.containers[0].image)')"

printf '%s' "$OVD410_WORKER_IMAGE" \
  | grep -Eq '^.+@sha256:[0-9a-f]{64}$'

if gcloud compute instances describe overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b >/dev/null 2>&1; then
  echo "Recovery VM already exists; stop and inspect." >&2
  exit 1
fi

if gcloud iam service-accounts describe \
  overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com \
  --project overdrafter-worker-9133 >/dev/null 2>&1; then
  echo "Recovery identity already exists; stop and inspect." >&2
  exit 1
fi

if gcloud compute firewall-rules describe \
  overdrafter-xometry-auth-recovery-iap \
  --project overdrafter-worker-9133 >/dev/null 2>&1; then
  echo "Recovery firewall already exists; stop and inspect." >&2
  exit 1
fi

OVD410_IAP_STATE="$(gcloud services list \
  --enabled \
  --project overdrafter-worker-9133 \
  --filter='config.name=iap.googleapis.com' \
  --format='value(config.name)')"
test -z "$OVD410_IAP_STATE"
OVD410_IAP_INITIAL_STATE='DISABLED'
export OVD410_IAP_INITIAL_STATE
unset OVD410_IAP_STATE

OVD410_RECOVERY_MEMBER='serviceAccount:overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com'
gcloud artifacts repositories get-iam-policy cloud-run-source-deploy \
  --project overdrafter-worker-9133 \
  --location us-west1 \
  --format=json \
  | jq -e --arg member "$OVD410_RECOVERY_MEMBER" \
    '[.bindings[]? | select(.members[]? == $member)] | length == 0' >/dev/null

# Resolve the separately authorized operator without printing the account. The
# exact operator must not already hold Token Creator on the worker identity.
OVD410_OPERATOR_ACCOUNT="$(gcloud config get-value account 2>/dev/null)"
printf '%s' "$OVD410_OPERATOR_ACCOUNT" \
  | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
OVD410_OPERATOR_MEMBER="user:$OVD410_OPERATOR_ACCOUNT"
export OVD410_OPERATOR_ACCOUNT OVD410_OPERATOR_MEMBER
gcloud iam service-accounts get-iam-policy \
  overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
  --project overdrafter-worker-9133 \
  --format=json \
  | jq -e --arg member "$OVD410_OPERATOR_MEMBER" \
    '[.bindings[]? | select(.role == "roles/iam.serviceAccountTokenCreator") | .members[]? | select(. == $member)] | length == 0' \
    >/dev/null
```

Provision only the fixed recovery identities. If the service account or
firewall rule already exists, stop instead of adopting it. The current Ubuntu
LTS host installs only Docker and the localhost display bridge; the browser,
Camoufox assets, application code, and every dashboard classifier come from the
exact retained worker image. The host uses a Standard `n2-standard-2`
machine because E2 Standard VMs cannot select the required `TERMINATE`
maintenance policy and Spot capacity can be reclaimed during owner-controlled
login. The host disables automatic restart and is still deleted immediately
after verified transfer.

```bash
set -euo pipefail

gcloud services enable iap.googleapis.com \
  --project overdrafter-worker-9133

gcloud iam service-accounts create overdrafter-xometry-recovery \
  --project overdrafter-worker-9133 \
  --display-name='OVD-410 temporary Xometry recovery'

# A newly created service account can be visible to IAM before Artifact
# Registry accepts it as a policy member. Retry only this idempotent binding for
# at most one minute; do not continue unless a successful write is observed.
OVD410_REPOSITORY_BINDING_ADDED='FALSE'
for _attempt in $(seq 1 12); do
  if gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy \
    --project overdrafter-worker-9133 \
    --location us-west1 \
    --member='serviceAccount:overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com' \
    --role='roles/artifactregistry.reader' >/dev/null 2>&1; then
    OVD410_REPOSITORY_BINDING_ADDED='TRUE'
    break
  fi
  sleep 5
done
test "$OVD410_REPOSITORY_BINDING_ADDED" = 'TRUE'
unset OVD410_REPOSITORY_BINDING_ADDED _attempt

gcloud compute firewall-rules create overdrafter-xometry-auth-recovery-iap \
  --project overdrafter-worker-9133 \
  --network overdrafter-xometry-egress \
  --direction INGRESS \
  --priority 1000 \
  --action ALLOW \
  --rules tcp:22 \
  --source-ranges 35.235.240.0/20 \
  --target-tags overdrafter-xometry-auth-recovery

gcloud compute instances create overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --machine-type n2-standard-2 \
  --network-interface=network=overdrafter-xometry-egress,subnet=overdrafter-xometry-egress-us-west1,no-address,stack-type=IPV4_ONLY \
  --image-family ubuntu-2404-lts-amd64 \
  --image-project ubuntu-os-cloud \
  --boot-disk-size 20GB \
  --boot-disk-type pd-balanced \
  --service-account overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com \
  --scopes cloud-platform \
  --tags overdrafter-xometry-auth-recovery \
  --labels ovd410-purpose=xometry-auth-recovery,ovd410-contract=recovery-host-v1 \
  --metadata enable-oslogin=TRUE,block-project-ssh-keys=TRUE,serial-port-enable=FALSE,ovd410-worker-image="$OVD410_WORKER_IMAGE" \
  --metadata-from-file startup-script=scripts/ovd410-recovery-host-startup.sh \
  --shielded-secure-boot \
  --shielded-vtpm \
  --shielded-integrity-monitoring \
  --no-can-ip-forward \
  --no-deletion-protection \
  --maintenance-policy TERMINATE \
  --no-restart-on-failure
```

The startup script does not launch a browser or contact Xometry. It binds VNC
and noVNC to loopback only, pulls the exact worker image, removes the temporary
registry login, and writes a readiness marker. After startup completes, run the
recovery-aware verifier. It rechecks the entire stable-egress contract while
allowing exactly one NAT mapping—the named private recovery VM—and rejects an
external IPv4/IPv6 address, alias range, broad or competing firewall/host,
project-level recovery role, recovery access to the snapshot bucket,
mutable/different-repository worker image, missing bucket control, competing
mapping, public principal, or service/Job/access-policy drift. The host also
allows container DNS only on TCP/UDP port 53 at the Compute Engine metadata IP
and rejects every other request to that address, so the interactive browser can
resolve names without reaching the VM service-account token.

The ordinary verifier command below requires the worker's narrow snapshot role
to remain present. If a verified host is replaced after the role has already
been revoked, rerun the same command with
`XOMETRY_RECOVERY_SNAPSHOT_ACCESS_PHASE=revoked`; that phase accepts only total
worker-role absence and still rejects recovery-host bucket access.

```bash
set -euo pipefail

GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
CLOUD_RUN_REGION=us-west1 \
CLOUD_RUN_SERVICE_ACCOUNT=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
CLOUD_RUN_NETWORK=overdrafter-xometry-egress \
CLOUD_RUN_SUBNET=overdrafter-xometry-egress-us-west1 \
CLOUD_RUN_SUBNET_RANGE=10.81.0.0/26 \
CLOUD_RUN_ROUTER=overdrafter-xometry-egress-router \
CLOUD_RUN_NAT=overdrafter-xometry-egress-nat \
CLOUD_RUN_NAT_ADDRESS=overdrafter-xometry-egress-ip \
CLOUD_RUN_NAT_ADDRESS_ID=7266654960671511103 \
npm run verify:xometry-recovery-host

gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --command='set -euo pipefail
    image="$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/ovd410-worker-image)"
    sudo test -f /run/ovd410-recovery-host-ready
    sudo docker image inspect "$image" >/dev/null
    sudo iptables -C DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT
    sudo iptables -C DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT
    sudo iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT
    sudo systemctl is-active --quiet ovd410-xvfb.service
    sudo systemctl is-active --quiet ovd410-x11vnc.service
    sudo systemctl is-active --quiet ovd410-novnc.service
    printf "%s\n" "Recovery runtime readiness passed."'
```

Before opening the provider, complete the destructive half of
[Rollback and snapshot-credential revocation](../../worker/README.md#rollback-and-snapshot-credential-revocation):
keep rollout off and queues empty, revoke the worker's bucket access, prove the
worker identity cannot read the still-present object, use the exclusive recovery
NAT mapping to prove no old worker instance exists, delete every old generation,
and record the completed provider-session rotation. Resolve the protected
bucket/object values from the Job in the operator shell; do not print them. The
production worker's narrow bucket role is `roles/storage.objectUser`:

```bash
set -euo pipefail

gcloud storage buckets remove-iam-policy-binding \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET" \
  --project overdrafter-worker-9133 \
  --member='serviceAccount:overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com' \
  --role='roles/storage.objectUser'

OVD410_TOKEN_BINDING_ADDED='FALSE'
cleanup_ovd410_token_binding() {
  if [[ "$OVD410_TOKEN_BINDING_ADDED" == 'TRUE' ]]; then
    gcloud iam service-accounts remove-iam-policy-binding \
      overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
      --project overdrafter-worker-9133 \
      --member="$OVD410_OPERATOR_MEMBER" \
      --role='roles/iam.serviceAccountTokenCreator'
  fi
}
trap cleanup_ovd410_token_binding EXIT

gcloud iam service-accounts add-iam-policy-binding \
  overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
  --project overdrafter-worker-9133 \
  --member="$OVD410_OPERATOR_MEMBER" \
  --role='roles/iam.serviceAccountTokenCreator'
OVD410_TOKEN_BINDING_ADDED='TRUE'

OVD410_WORKER_TOKEN=''
for _attempt in $(seq 1 12); do
  if OVD410_WORKER_TOKEN="$(gcloud auth print-access-token \
    --lifetime=300s \
    --impersonate-service-account=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
    2>/dev/null)"; then
    break
  fi
  sleep 5
done
test -n "$OVD410_WORKER_TOKEN"
unset _attempt
OVD410_BUCKET_ENCODED="$(node -e \
  'process.stdout.write(encodeURIComponent(process.argv[1]))' \
  "$XOMETRY_PROFILE_SNAPSHOT_BUCKET")"
OVD410_OBJECT_ENCODED="$(node -e \
  'process.stdout.write(encodeURIComponent(process.argv[1]))' \
  "$XOMETRY_PROFILE_SNAPSHOT_OBJECT")"
OVD410_REVOKED_STATUS="$({
  printf 'header = "Authorization: Bearer %s"\n' "$OVD410_WORKER_TOKEN"
  printf '%s\n' 'silent' 'show-error' 'output = "/dev/null"' 'write-out = "%{http_code}"'
} | curl --config - \
  "https://storage.googleapis.com/storage/v1/b/$OVD410_BUCKET_ENCODED/o/$OVD410_OBJECT_ENCODED")"
test "$OVD410_REVOKED_STATUS" = "403"
unset OVD410_WORKER_TOKEN OVD410_BUCKET_ENCODED OVD410_OBJECT_ENCODED OVD410_REVOKED_STATUS

cleanup_ovd410_token_binding
OVD410_TOKEN_BINDING_ADDED='FALSE'
trap - EXIT
gcloud iam service-accounts get-iam-policy \
  overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
  --project overdrafter-worker-9133 \
  --format=json \
  | jq -e --arg member "$OVD410_OPERATOR_MEMBER" \
    '[.bindings[]? | select(.role == "roles/iam.serviceAccountTokenCreator") | .members[]? | select(. == $member)] | length == 0' \
    >/dev/null

gcloud storage rm --all-versions \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET/$XOMETRY_PROFILE_SNAPSHOT_OBJECT" \
  --project overdrafter-worker-9133

# This command returns live and noncurrent versions and exits nonzero on lookup
# failures; an empty successful response is therefore the only accepted absence.
OVD410_OLD_GENERATIONS="$(gcloud storage objects list \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET/$XOMETRY_PROFILE_SNAPSHOT_OBJECT" \
  --project overdrafter-worker-9133 \
  --limit=1 \
  --format='value(name,generation)')"
test -z "$OVD410_OLD_GENERATIONS"
unset OVD410_OLD_GENERATIONS
```

Only after the verifier and readiness check pass may the separately authorized
revocation and provider ceremony begin. Open an IAP SSH tunnel that forwards the
loopback-only noVNC endpoint, then visit
`http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale` locally. The human
account owner controls login and MFA in that view. Do not paste a password into
a command, metadata, Linear, logs, or this repository.

```bash
set -euo pipefail

gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --ssh-flag='-N' \
  --ssh-flag='-L127.0.0.1:6080:127.0.0.1:6080'
```

In that protected SSH session, run the exact image against a new dedicated
profile. The command opens only the interactive login/dashboard flow. Images
that contain the recovery orchestrator also perform the guarded closed-browser
cold relaunch before returning success. The container shares the dedicated
temporary host's IPC namespace so Camoufox's X11 shared-memory frames reach the
host-owned virtual display; do not reuse this command on a multi-tenant host.

```bash
set -euo pipefail

OVD410_WORKER_IMAGE="$(curl -fsS \
  -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/ovd410-worker-image)"

sudo docker run --rm -it \
  --name ovd410-xometry-auth-recovery \
  --network bridge \
  --ipc=host \
  --env DISPLAY=:99 \
  --env WORKER_MODE=simulate \
  --env XOMETRY_BROWSER_ENGINE=camoufox \
  --env XOMETRY_USER_DATA_DIR=/credential/profile \
  --env PLAYWRIGHT_HEADLESS=true \
  --env PLAYWRIGHT_CAPTURE_TRACE=false \
  --env PLAYWRIGHT_BROWSER_TIMEOUT_MS=45000 \
  --volume /tmp/.X11-unix:/tmp/.X11-unix \
  --volume /var/lib/ovd410-credential:/credential \
  "$OVD410_WORKER_IMAGE" \
  node dist/tools/xometryAuth.js
```

If the retained exact image predates the built-in recovery orchestrator, close
the first successful browser lifecycle and rerun the exact same command against
the same closed profile. The second lifecycle must open the authenticated
dashboard without credential or MFA entry, and its dashboard classifier must
exit zero. This compatibility path is the cold-relaunch proof; it is not either
separately gated no-upload probe. Do not export unless the built-in orchestrator
passes or both exact-image dashboard-classifier lifecycles pass.

After the authenticated dashboard and cold-relaunch classifiers both pass,
export without network access, transfer the archive only through IAP, and keep
it in a new mode-0700 temporary directory. This still does not authorize an
object write.

```bash
set -euo pipefail

sudo docker run --rm \
  --network none \
  --env XOMETRY_BROWSER_ENGINE=camoufox \
  --env XOMETRY_USER_DATA_DIR=/credential/profile \
  --volume /var/lib/ovd410-credential:/credential \
  "$OVD410_WORKER_IMAGE" \
  node dist/tools/exportXometryProfile.js /credential/profile.tgz

sudo chown "$(id -u):$(id -g)" \
  /var/lib/ovd410-credential \
  /var/lib/ovd410-credential/profile.tgz
chmod 0700 /var/lib/ovd410-credential
chmod 0600 /var/lib/ovd410-credential/profile.tgz
```

From the operator machine:

```bash
set -euo pipefail

OVD410_LOCAL_DIR="$(mktemp -d)"
chmod 0700 "$OVD410_LOCAL_DIR"

gcloud compute scp \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  overdrafter-xometry-auth-recovery:/var/lib/ovd410-credential/profile.tgz \
  "$OVD410_LOCAL_DIR/profile.tgz"

OVD410_REMOTE_SHA="$(gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --command='sha256sum /var/lib/ovd410-credential/profile.tgz | cut -d " " -f 1')"
OVD410_LOCAL_SHA="$(shasum -a 256 "$OVD410_LOCAL_DIR/profile.tgz" | cut -d ' ' -f 1)"
test "$OVD410_REMOTE_SHA" = "$OVD410_LOCAL_SHA"
unset OVD410_REMOTE_SHA OVD410_LOCAL_SHA
```

After the verified transfer, close the local SSH/IAP tunnel and delete the VM
immediately so its auto-deleted boot disk removes the live profile. Then remove
the IAP rule, repository binding, dedicated identity, and temporarily enabled
API. Do not retain the host merely to make recovery easier. Before running this
block, set `OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED=TRUE` in the dedicated
operator shell only after the project owner confirms that no independent IAP
consumer exists. The August 23, 2026 owner declaration that no consumer will
exist before beta readiness is standing confirmation for pre-beta OVD-410
recovery sessions; invalidate it at beta readiness, on owner revocation, or on
any contrary project evidence. Otherwise leave the variable unset and record
why the API remains enabled.

```bash
set -euo pipefail

gcloud compute instances delete overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b

gcloud compute firewall-rules delete overdrafter-xometry-auth-recovery-iap \
  --project overdrafter-worker-9133

gcloud artifacts repositories remove-iam-policy-binding cloud-run-source-deploy \
  --project overdrafter-worker-9133 \
  --location us-west1 \
  --member='serviceAccount:overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com' \
  --role='roles/artifactregistry.reader'

gcloud iam service-accounts delete \
  overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com \
  --project overdrafter-worker-9133

# The containment preflight recorded whether IAP was initially disabled. Do not
# disable the API unless the operator has a current session-specific or standing
# pre-beta confirmation of no independent project use. Otherwise leave the API
# enabled and record why.
if [[ "${OVD410_IAP_INITIAL_STATE:-UNKNOWN}" == 'DISABLED' && \
      "${OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED:-FALSE}" == 'TRUE' ]]; then
  gcloud services disable iap.googleapis.com \
    --project overdrafter-worker-9133
else
  printf '%s\n' \
    'IAP API teardown skipped; record the independent-use or missing-preflight reason.' >&2
fi
```

Recheck that the host resources and every old object generation are absent.
Then seed the absent object exactly once and restore only the worker's prior
narrow object access:

```bash
set -euo pipefail

OVD410_RECOVERY_MEMBER='serviceAccount:overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com'

if gcloud compute instances describe overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b >/dev/null 2>&1; then exit 1; fi
if gcloud compute firewall-rules describe overdrafter-xometry-auth-recovery-iap \
  --project overdrafter-worker-9133 >/dev/null 2>&1; then exit 1; fi
if gcloud iam service-accounts describe \
  overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com \
  --project overdrafter-worker-9133 >/dev/null 2>&1; then exit 1; fi

OVD410_IAP_STATE="$(gcloud services list \
  --enabled \
  --project overdrafter-worker-9133 \
  --filter='config.name=iap.googleapis.com' \
  --format='value(config.name)')"
if [[ "${OVD410_IAP_INITIAL_STATE:-UNKNOWN}" == 'DISABLED' && \
      "${OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED:-FALSE}" == 'TRUE' ]]; then
  test -z "$OVD410_IAP_STATE"
else
  test "$OVD410_IAP_STATE" = 'iap.googleapis.com'
fi
unset OVD410_IAP_STATE

gcloud artifacts repositories get-iam-policy cloud-run-source-deploy \
  --project overdrafter-worker-9133 \
  --location us-west1 \
  --format=json \
  | jq -e --arg member "$OVD410_RECOVERY_MEMBER" \
    '[.bindings[]? | select(.members[]? == $member)] | length == 0' >/dev/null

# As above, only an empty successful live-and-noncurrent listing proves absence.
OVD410_OLD_GENERATIONS="$(gcloud storage objects list \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET/$XOMETRY_PROFILE_SNAPSHOT_OBJECT" \
  --project overdrafter-worker-9133 \
  --limit=1 \
  --format='value(name,generation)')"
test -z "$OVD410_OLD_GENERATIONS"
unset OVD410_OLD_GENERATIONS

gcloud storage cp --if-generation-match=0 \
  "$OVD410_LOCAL_DIR/profile.tgz" \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET/$XOMETRY_PROFILE_SNAPSHOT_OBJECT" \
  --project overdrafter-worker-9133

gcloud storage buckets add-iam-policy-binding \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET" \
  --project overdrafter-worker-9133 \
  --member='serviceAccount:overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com' \
  --role='roles/storage.objectUser'

OVD410_LOCAL_SIZE="$(wc -c < "$OVD410_LOCAL_DIR/profile.tgz" | tr -d ' ')"
OVD410_SEED_METADATA="$(gcloud storage objects describe \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET/$XOMETRY_PROFILE_SNAPSHOT_OBJECT" \
  --project overdrafter-worker-9133 \
  --format=json)"
test "$(jq -r '.size' <<<"$OVD410_SEED_METADATA")" = "$OVD410_LOCAL_SIZE"
jq -e '.generation | tonumber > 0' <<<"$OVD410_SEED_METADATA" >/dev/null
unset OVD410_LOCAL_SIZE OVD410_SEED_METADATA

gcloud storage buckets get-iam-policy \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET" \
  --project overdrafter-worker-9133 \
  --format=json \
  | jq -e \
    'any(.bindings[]?; .role == "roles/storage.objectUser" and ((.members // []) | index("serviceAccount:overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com") != null))' \
    >/dev/null
```

Delete the local archive immediately after the generation/size and restored-IAM
readbacks pass. Require the ordinary stable-egress verifier to pass again with
zero NAT mappings before requesting authorization for probe one. Do not run a
probe while the recovery VM, recovery identity/binding, or local archive exists.

```bash
set -euo pipefail

rm -f "$OVD410_LOCAL_DIR/profile.tgz"
rmdir "$OVD410_LOCAL_DIR"
```

If setup, login, cold relaunch, export, transfer, revocation, generation-zero
seeding, access restoration, or teardown is ambiguous, stop. Remove the
temporary host contract, keep provider rollout disabled, and do not run either
fresh-instance probe.

## Cost envelope

At current public list pricing, one reserved address used by Public NAT costs
`$0.005/hour` (about `$3.60` per 30-day month). Public NAT additionally charges
`$0.0014/hour` per assigned instance up to 32, `$0.045/GiB` processed, ordinary
data transfer, and Cloud Logging usage. Scale-to-zero limits runtime use but does
not release the reserved address. Record actual Billing-report evidence after
the experiment; do not describe this estimate as an invoice.

## Rollback and teardown

Rollback is configuration-first. Keep all rollout controls off and confirm no
Job execution or vendor task is active. Disconnect both Cloud Run resources:

```bash
GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
CLOUD_RUN_REGION=us-west1 \
CLOUD_RUN_SERVICE_ACCOUNT=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
worker/scripts/configure-xometry-auth-probe-job.sh --clear-network

GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
CLOUD_RUN_REGION=us-west1 \
CLOUD_RUN_SERVICE_ACCOUNT=overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com \
node scripts/configure-xometry-worker-egress.mjs --clear-network
```

Verify both resources have no network annotations and the service remains
private. Cloud Run can retain subnet allocations for one to two hours after a
disconnect, so do not force deletion while dependencies remain. After the
subnet is no longer referenced, delete only these exact resources in order:

```bash
gcloud compute routers nats delete overdrafter-xometry-egress-nat \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  --router overdrafter-xometry-egress-router

gcloud compute routers delete overdrafter-xometry-egress-router \
  --project overdrafter-worker-9133 \
  --region us-west1

gcloud compute addresses delete overdrafter-xometry-egress-ip \
  --project overdrafter-worker-9133 \
  --region us-west1

gcloud compute networks subnets delete overdrafter-xometry-egress-us-west1 \
  --project overdrafter-worker-9133 \
  --region us-west1

gcloud compute networks delete overdrafter-xometry-egress \
  --project overdrafter-worker-9133
```

Do not disable the Compute API as part of ordinary rollback. Record the exact
detach and deletion results in the rolling `OVD-410` comment. If authentication
integrity becomes uncertain later, use the separate full snapshot credential-
revocation procedure before any further provider-facing operation.

## References

- [Cloud Run static outbound IP](https://cloud.google.com/run/docs/configuring/static-outbound-ip)
- [Cloud Run Direct VPC egress](https://cloud.google.com/run/docs/configuring/vpc-direct-vpc)
- [Public NAT setup](https://cloud.google.com/nat/docs/set-up-manage-network-address-translation)
- [Cloud NAT pricing](https://cloud.google.com/nat/pricing)
- [IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding)
- [Public NAT for a VM without an external address](https://cloud.google.com/nat/docs/gce-example)
