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
The deployed generic envelope did not identify the internal failure stage. A
follow-up image added only an allowlisted `failureStage` classification without
low-level diagnostics. One separately authorized execution of that image then
failed closed at `guard_verification`; it used one task and zero retries,
performed no file selection or user interaction, did not persist the snapshot,
and the quiescent verifier passed before and after execution. A provider-free,
network-isolated reproduction against the exact deployed image confirmed that
closing the last restored Camoufox page before creating the guarded page can
invalidate Firefox's persistent window. The checked-in localized repair creates
and verifies the guarded page while still offline, closes restored pages only
after a replacement page exists, and enables network only after both steps
pass. A network-isolated Linux container smoke test of the repaired image
reached the expected navigation boundary instead of failing guard verification.
Source-network binding and repeatable hosted authentication remain unproven.

## Fixed production contract

| Resource                     | Required value                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Project                      | `overdrafter-worker-9133`                                                      |
| Region                       | `us-west1`                                                                     |
| Network                      | `overdrafter-xometry-egress`                                                   |
| Subnet                       | `overdrafter-xometry-egress-us-west1`                                          |
| Subnet range                 | `10.81.0.0/26`                                                                 |
| Reserved address             | `overdrafter-xometry-egress-ip`                                                |
| Reserved-address resource ID | `7266654960671511103`                                                          |
| Router                       | `overdrafter-xometry-egress-router`                                            |
| Public NAT                   | `overdrafter-xometry-egress-nat`                                               |
| Worker service               | `overdrafter-cad-worker`                                                       |
| Authentication Job           | `overdrafter-xometry-auth-probe`                                               |
| Runtime service account      | `overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com`    |
| Temporary recovery VM        | `overdrafter-xometry-auth-recovery` in `us-west1-b`                            |
| Recovery service account     | `overdrafter-xometry-recovery@overdrafter-worker-9133.iam.gserviceaccount.com` |
| Recovery firewall rule       | `overdrafter-xometry-auth-recovery-iap`                                        |
| Recovery image repository    | `cloud-run-source-deploy` (`roles/artifactregistry.reader` only)               |
| Temporary access API         | `iap.googleapis.com` (restored to disabled after teardown)                     |

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
passed. Network-isolated inspection then proved that image also contains the
separately gated OVD-408 multi-offer modules while the production database lacks
the required four-migration suffix, `geographic_origin` column, and
reconciliation RPC. Disabled rollout and an empty vendor queue contain the
incompatible partial release, but it is not eligible for quote tasks. The next
OVD-410 image must be built from a clean pre-OVD-408 worker source containing
only the byte-identical current probe lifecycle repair and stable-egress deploy
guard. Keep rollout disabled and work quiescent until a later qualified
migration-first release restores the complete merged worker to both governed
resources. Do not treat a shared image as proof of the current executable
contract unless its deployed digest is inspected for the intended bounded
contents.

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

`OVD420_RECOVERY_EGRESS_POLICY_FILE` must be the separately reviewed exact-
hostname policy for this recovery attempt. OVD-420 supplies and tests the
enforcement mechanism but does not guess the production hostname inventory;
OVD-410 owns that qualification. Keep the reviewed production policy
uncommitted. The checked-in control validates it and derives the canonical
SHA-256 in the protected operator environment before any cloud resource is
created; carry that digest forward as
`OVD420_RECOVERY_EGRESS_POLICY_SHA256` rather than deriving trust from instance
metadata.

```bash
set -euo pipefail

: "${OVD420_RECOVERY_EGRESS_POLICY_FILE:?set the reviewed policy JSON path}"
test -f "$OVD420_RECOVERY_EGRESS_POLICY_FILE"
OVD420_RECOVERY_EGRESS_POLICY_SHA256="$(
  scripts/ovd420-recovery-egress-control.sh validate \
    "$OVD420_RECOVERY_EGRESS_POLICY_FILE"
)"
printf '%s' "$OVD420_RECOVERY_EGRESS_POLICY_SHA256" \
  | grep -Eq '^[0-9a-f]{64}$'
export OVD420_RECOVERY_EGRESS_POLICY_SHA256

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
  --metadata-from-file startup-script=scripts/ovd410-recovery-host-startup.sh,ovd420-recovery-egress-control=scripts/ovd420-recovery-egress-control.sh,ovd420-recovery-egress-policy="$OVD420_RECOVERY_EGRESS_POLICY_FILE" \
  --shielded-secure-boot \
  --shielded-vtpm \
  --shielded-integrity-monitoring \
  --no-can-ip-forward \
  --no-deletion-protection \
  --maintenance-policy TERMINATE \
  --no-restart-on-failure
```

The startup script does not launch a browser or send application traffic to
Xometry. It binds VNC and noVNC to loopback only, pulls the exact worker image,
removes the temporary registry login, installs the exact metadata-bound OVD-420
control and policy, and writes a readiness marker only after the internal
Docker network, allowlist DNS, SNI gateway, and ordered firewall denies pass.
After startup completes, run the
recovery-aware verifier. It rechecks the entire stable-egress contract while
allowing exactly one NAT mapping—the named private recovery VM—and rejects an
external IPv4/IPv6 address, alias range, broad or competing firewall/host,
project-level recovery role, recovery access to the snapshot bucket,
mutable/different-repository worker image, missing bucket control, competing
mapping, public principal, service/Job/access-policy drift, changed OVD-420
control bytes, non-root control ownership, non-0700 control mode, unstable
installed-control readback, malformed policy, metadata/runtime policy drift
from the operator-supplied canonical digest, unhealthy gateway/DNS, competing
internal-network container, or firewall drift. The verifier independently
fingerprints the installed control over IAP before and after runtime evidence
collection and compares its SHA-256 with both the checked-in bytes and metadata;
it does not accept the installed control's JSON as self-authenticating. Browser
containers cannot use the Compute Engine resolver or token endpoint directly: their
internal network can reach only the host's exact allowlist DNS and SNI gateway.

The ordinary verifier command below requires the worker's narrow snapshot role
to remain present. If a verified host is replaced after the role has already
been revoked, rerun the same command with
`XOMETRY_RECOVERY_SNAPSHOT_ACCESS_PHASE=revoked`; that phase accepts only total
worker-role absence and still rejects recovery-host bucket access.

```bash
set -euo pipefail

: "${OVD420_RECOVERY_EGRESS_POLICY_SHA256:?set from the reviewed uncommitted policy}"
printf '%s' "$OVD420_RECOVERY_EGRESS_POLICY_SHA256" \
  | grep -Eq '^[0-9a-f]{64}$'

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
OVD420_RECOVERY_EGRESS_POLICY_SHA256="$OVD420_RECOVERY_EGRESS_POLICY_SHA256" \
npm run verify:xometry-recovery-host

gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --command='set -euo pipefail
    image="$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/ovd410-worker-image)"
    sudo test -f /run/ovd410-recovery-host-ready
    sudo docker image inspect "$image" >/dev/null
    ! sudo iptables -C DOCKER-USER -p udp -d 169.254.169.254/32 --dport 53 -j ACCEPT 2>/dev/null
    ! sudo iptables -C DOCKER-USER -p tcp -d 169.254.169.254/32 --dport 53 -j ACCEPT 2>/dev/null
    sudo iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT
    sudo /usr/local/sbin/ovd420-recovery-egress-control verify
    sudo systemctl is-active --quiet ovd410-xvfb.service
    sudo systemctl is-active --quiet ovd410-x11vnc.service
    sudo systemctl is-active --quiet ovd410-novnc.service
    printf "%s\n" "Recovery runtime readiness passed."'
```

### Classifier-only diagnostic after probe A

Do not execute this diagnostic without its separate provider authorization and
the OVD-410-reviewed production hostname policy. OVD-420 supplies one shared,
versioned control for this classifier and the full credential-recovery command:
the browser runs on an internal Docker network, exact allowed names resolve only
to the host SNI gateway, and all direct or bypass routes remain denied. The
command fails before browser launch when the policy digest, services, topology,
firewall, DNS, or gateway has drifted.

One recovery-only exception may be authorized after probe A solely to classify
the exact-runtime
interactive dashboard and its guarded closed-browser cold relaunch. This
exception does **not** begin or partially perform the full
recovery/reseed ceremony below. In particular, do not revoke the production
worker's bucket role and do not download, delete, replace, export, archive,
transfer, or otherwise mutate any production snapshot generation. The protected
operator may perform only the required generation/size and IAM metadata
readbacks; the recovery host and classifier receive no snapshot identifier or
credential.

This exception is safe only while all of these conditions remain true:

1. rollout and billing controls remain off, queues and requests remain empty,
   the Cloud Run Job execution baseline is exactly 11 historical completed
   executions and zero active executions, and the exact execution inventory,
   snapshot generation, size, and worker IAM binding are recorded before the
   diagnostic and rechecked with no delta afterward;
2. the owner's standing pre-beta confirmation that no independent consumer or
   writer exists remains current for the entire diagnostic. Stop on contrary
   project evidence, owner revocation, beta readiness, or any admitted schema or
   RPC migration; point-in-time queue/request proofs are insufficient without
   this external quiescence invariant;
3. the recovery-aware verifier passes in its default `granted` phase, proving
   the temporary recovery identity has no snapshot-bucket or project role and
   the private host has only the fixed Artifact Registry reader binding;
4. the image is an approved immutable digest from the fixed repository and is
   byte-for-byte the image used by the governed service and Job;
5. authorization records both that immutable image digest and the SHA-256 of
   the exact classifier command text below; any text or digest change requires
   new authorization; and
6. the mode is classifier-only: the only provider operation is interactive
   dashboard classification followed by the built-in guarded cold relaunch.
   Export, SCP, archive creation, snapshot environment variables, storage CLI
   calls, and retention of the host/profile after classification are forbidden.

In the dedicated operator shell, set the separately approved image and payload
hash without printing either. The payload includes the fixed mode, both copies
of the approved/observed image digest, and the exact classifier command. The
trailing newline is part of the hash. Do not edit or reconstruct the payload
after approval.

First, open the exception's own loopback-only display tunnel in a separate
terminal and leave it open until classification ends:

```bash
set -euo pipefail

gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --ssh-flag='-N' \
  --ssh-flag='-L127.0.0.1:6080:127.0.0.1:6080'
```

Visit `http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale` locally. The
human account owner performs all provider interaction in that view. Never put a
password or MFA value in a command, metadata, logs, or the repository. Return
to the original dedicated operator shell for the hash-locked launch below; do
not borrow the later full-recovery tunnel across its destructive gate.

```bash
set -euo pipefail

OVD410_CLASSIFIER_DIAGNOSTIC_IMAGE='<approved-immutable-image-digest>'
OVD410_CLASSIFIER_PAYLOAD_SHA256='<approved-sha256-of-complete-payload>'
: "${OVD420_RECOVERY_EGRESS_POLICY_SHA256:?reuse the digest validated and exported during provisioning}"
OVD410_CLASSIFIER_REMOTE_PAYLOAD='/run/ovd410-classifier-payload.sh'
printf '%s' "$OVD420_RECOVERY_EGRESS_POLICY_SHA256" | grep -Eq '^[0-9a-f]{64}$'
test "${OVD410_IAP_INITIAL_STATE:?}" = 'DISABLED'
OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED='TRUE'
export OVD410_IAP_INITIAL_STATE OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED

cleanup_ovd410_classifier_diagnostic() {
  local classifier_status="${1:-$?}"
  # Cleanup is the fail-closed boundary. Defer termination signals until every
  # independent compensation and final readback has completed.
  trap '' HUP INT TERM
  set +e
  GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
  OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED="$OVD410_NO_INDEPENDENT_IAP_USE_CONFIRMED" \
    node scripts/teardown-ovd410-recovery-host.mjs
  local teardown_status="$?"
  set -e
  if [[ "$teardown_status" -ne 0 ]]; then
    return 1
  fi
  return "$classifier_status"
}
trap 'ovd410_status=$?; trap "" HUP INT TERM; trap - EXIT; cleanup_ovd410_classifier_diagnostic "$ovd410_status"; exit $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

OVD410_CLASSIFIER_COMMAND="$(cat <<'OVD410_CLASSIFIER_COMMAND_EOF'
set -euo pipefail
test "${OVD410_RECOVERY_MODE:?}" = 'classifier-only'
test "${OVD410_APPROVED_IMAGE:?}" = "${OVD410_HOST_IMAGE:?}"
printf '%s' "$OVD410_APPROVED_IMAGE" \
  | grep -Eq '^us-west1-docker\.pkg\.dev/overdrafter-worker-9133/cloud-run-source-deploy/.+@sha256:[0-9a-f]{64}$'
sudo install -d -m 0700 /var/lib/ovd410-classifier-diagnostic
if ! classifier_entries="$(
  sudo find /var/lib/ovd410-classifier-diagnostic -mindepth 1 -print -quit
)"; then
  exit 1
fi
test -z "$classifier_entries"
unset classifier_entries
export OVD420_RECOVERY_EGRESS_POLICY_SHA256
sudo --preserve-env=OVD420_RECOVERY_EGRESS_POLICY_SHA256 \
  /usr/local/sbin/ovd420-recovery-egress-control launch \
  classifier-only \
  "$OVD410_APPROVED_IMAGE" \
  /var/lib/ovd410-classifier-diagnostic
sudo test ! -e /var/lib/ovd410-classifier-diagnostic/profile.tgz
OVD410_CLASSIFIER_COMMAND_EOF
)"

OVD410_CLASSIFIER_EXECUTION_BASELINE="$(gcloud run jobs executions list \
  --job overdrafter-xometry-auth-probe \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  '--format=json(metadata.name,status.completionTime,status.runningCount)' \
  | jq -c 'sort_by(.metadata.name)')"
jq -e '
  length == 11 and
  all(.[]; (.status.completionTime | type == "string") and ((.status.runningCount // 0) == 0))
' <<<"$OVD410_CLASSIFIER_EXECUTION_BASELINE" >/dev/null

# Snapshot identifiers and the service-role secret remain in the protected
# operator shell. None are included in the staged payload or sent to the host.
: "${XOMETRY_PROFILE_SNAPSHOT_BUCKET:?}"
: "${XOMETRY_PROFILE_SNAPSHOT_OBJECT:?}"
collect_ovd410_operational_envelope() {
  local service_role_secret=''
  local envelope=''
  local collector_status=0

  if ! service_role_secret="$(gcloud secrets versions access latest \
    --secret supabase-service-role-key \
    --project overdrafter-worker-9133)"; then
    unset service_role_secret
    return 1
  fi
  if envelope="$(SUPABASE_SERVICE_ROLE_KEY="$service_role_secret" \
    node scripts/collect-ovd410-operational-envelope.mjs)"; then
    collector_status=0
  else
    collector_status="$?"
  fi
  unset service_role_secret
  if [[ "$collector_status" -ne 0 ]]; then
    return "$collector_status"
  fi
  printf '%s\n' "$envelope"
}
OVD410_CLASSIFIER_OPERATIONAL_BASELINE="$(collect_ovd410_operational_envelope)"
OVD410_CLASSIFIER_SNAPSHOT_BASELINE="$(gcloud storage objects describe \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET/$XOMETRY_PROFILE_SNAPSHOT_OBJECT" \
  --project overdrafter-worker-9133 \
  --format='json(generation,size)' | jq -cS .)"
collect_ovd410_snapshot_iam() {
  # Installed gcloud 558 requests IAM policy version 3 internally but returns
  # only the observable bindings and etag fields. Do not assert an unreturned
  # top-level version. Validate the response shape, then canonicalize the entire
  # returned JSON so binding conditions, etag, and any other returned field are
  # retained byte-for-byte in the before/after comparison.
  gcloud storage buckets get-iam-policy \
    "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET" \
    --project overdrafter-worker-9133 \
    --format=json \
    | jq -ceS '
        if ((type != "object") or
            ((.bindings // []) | type != "array") or
            (.etag | type != "string")) then
          error("invalid bucket IAM policy response")
        else
          .
        end
      '
}
OVD410_CLASSIFIER_SNAPSHOT_IAM_BASELINE="$(collect_ovd410_snapshot_iam)"

OVD410_HOST_IMAGE="$(gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --command='curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/ovd410-worker-image')"
test "$OVD410_HOST_IMAGE" = "$OVD410_CLASSIFIER_DIAGNOSTIC_IMAGE"

OVD410_CLASSIFIER_PAYLOAD="$({
  printf 'readonly OVD410_RECOVERY_MODE=%q\n' 'classifier-only'
  printf 'readonly OVD410_APPROVED_IMAGE=%q\n' "$OVD410_CLASSIFIER_DIAGNOSTIC_IMAGE"
  printf 'readonly OVD410_HOST_IMAGE=%q\n' "$OVD410_HOST_IMAGE"
  printf 'readonly OVD420_RECOVERY_EGRESS_POLICY_SHA256=%q\n' "$OVD420_RECOVERY_EGRESS_POLICY_SHA256"
  printf '%s\n' "$OVD410_CLASSIFIER_COMMAND"
})"
OVD410_CLASSIFIER_ACTUAL_SHA256="$(
  printf '%s\n' "$OVD410_CLASSIFIER_PAYLOAD" | shasum -a 256 | cut -d ' ' -f 1
)"
printf '%s' "$OVD410_CLASSIFIER_PAYLOAD_SHA256" | grep -Eq '^[0-9a-f]{64}$'
test "$OVD410_CLASSIFIER_ACTUAL_SHA256" = "$OVD410_CLASSIFIER_PAYLOAD_SHA256"

# Stage only the already-hashed bytes. The provider command is not run here.
printf '%s\n' "$OVD410_CLASSIFIER_PAYLOAD" \
  | gcloud compute ssh overdrafter-xometry-auth-recovery \
      --project overdrafter-worker-9133 \
      --zone us-west1-b \
      --tunnel-through-iap \
      --command='set -euo pipefail
        sudo rm -f -- /run/ovd410-classifier-payload.sh.tmp
        sudo install -o root -g root -m 0700 /dev/stdin /run/ovd410-classifier-payload.sh.tmp
        sudo mv -f -- /run/ovd410-classifier-payload.sh.tmp /run/ovd410-classifier-payload.sh'

OVD410_CLASSIFIER_REMOTE_SHA256="$(gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --command='sudo sha256sum /run/ovd410-classifier-payload.sh | cut -d " " -f 1')"
test "$OVD410_CLASSIFIER_REMOTE_SHA256" = "$OVD410_CLASSIFIER_PAYLOAD_SHA256"
OVD410_CLASSIFIER_REMOTE_MODE="$(gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --command="sudo stat --format='%U:%G:%a' /run/ovd410-classifier-payload.sh")"
test "$OVD410_CLASSIFIER_REMOTE_MODE" = 'root:root:700'

# Reverify the staged bytes inside the same interactive shell immediately before
# execution. Docker receives a real TTY, so the owner can press Enter after the
# browser confirmation performed through noVNC.
OVD410_CLASSIFIER_STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
set +e
gcloud compute ssh overdrafter-xometry-auth-recovery \
  --project overdrafter-worker-9133 \
  --zone us-west1-b \
  --tunnel-through-iap \
  --ssh-flag='-t' \
  --command="set -euo pipefail
    test \"\$(sudo sha256sum '$OVD410_CLASSIFIER_REMOTE_PAYLOAD' | cut -d ' ' -f 1)\" = '$OVD410_CLASSIFIER_PAYLOAD_SHA256'
    sudo bash '$OVD410_CLASSIFIER_REMOTE_PAYLOAD'"
OVD410_CLASSIFIER_STATUS="$?"
set -e
trap '' HUP INT TERM
trap - EXIT
# Cleanup receives zero here so `set -e` cannot skip the mandatory containment
# checks below. The captured classifier status remains authoritative and is
# returned only after every postcondition passes.
cleanup_ovd410_classifier_diagnostic 0
trap - HUP INT TERM

OVD410_CLASSIFIER_EXECUTION_AFTER="$(gcloud run jobs executions list \
  --job overdrafter-xometry-auth-probe \
  --project overdrafter-worker-9133 \
  --region us-west1 \
  '--format=json(metadata.name,status.completionTime,status.runningCount)' \
  | jq -c 'sort_by(.metadata.name)')"
test "$OVD410_CLASSIFIER_EXECUTION_AFTER" = "$OVD410_CLASSIFIER_EXECUTION_BASELINE"

# Complete the containment envelope before returning the preserved classifier
# status. Normal signal handling is restored because compensating teardown and
# its final temporary-resource readbacks have already succeeded.
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

node scripts/verify-ovd373-billing-disabled.mjs

OVD410_CLASSIFIER_OPERATIONAL_AFTER="$(collect_ovd410_operational_envelope)"
test "$OVD410_CLASSIFIER_OPERATIONAL_AFTER" = "$OVD410_CLASSIFIER_OPERATIONAL_BASELINE"
OVD410_CLASSIFIER_SNAPSHOT_AFTER="$(gcloud storage objects describe \
  "gs://$XOMETRY_PROFILE_SNAPSHOT_BUCKET/$XOMETRY_PROFILE_SNAPSHOT_OBJECT" \
  --project overdrafter-worker-9133 \
  --format='json(generation,size)' | jq -cS .)"
test "$OVD410_CLASSIFIER_SNAPSHOT_AFTER" = "$OVD410_CLASSIFIER_SNAPSHOT_BASELINE"
OVD410_CLASSIFIER_SNAPSHOT_IAM_AFTER="$(collect_ovd410_snapshot_iam)"
test "$OVD410_CLASSIFIER_SNAPSHOT_IAM_AFTER" = "$OVD410_CLASSIFIER_SNAPSHOT_IAM_BASELINE"

# Run this last. Three timestamp-only observations with two 15-second gaps give
# request-log ingestion an explicit bounded 30-second settling window. Raw log
# entries, request fields, URLs, headers, and provider content are never read.
for OVD410_LOG_OBSERVATION in 1 2 3; do
  OVD410_CLASSIFIER_SERVICE_REQUEST="$(gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"overdrafter-cad-worker\" AND resource.labels.location=\"us-west1\" AND logName=\"projects/overdrafter-worker-9133/logs/run.googleapis.com%2Frequests\" AND timestamp>=\"$OVD410_CLASSIFIER_STARTED_AT\"" \
    --project overdrafter-worker-9133 \
    --limit=1 \
    --format='json(timestamp)')"
  jq -e 'type == "array" and length == 0' \
    <<<"$OVD410_CLASSIFIER_SERVICE_REQUEST" >/dev/null
  if [[ "$OVD410_LOG_OBSERVATION" -lt 3 ]]; then
    sleep 15
  fi
done
unset OVD410_LOG_OBSERVATION OVD410_CLASSIFIER_SERVICE_REQUEST
exit "$OVD410_CLASSIFIER_STATUS"
```

The fixed payload passes only the classifier mode and the two already-compared
immutable image values into the root shell; it does not forward the operator
environment. Never interpolate other values into the payload. Staging does not
execute the image or contact the provider. The root-owned mode-0700 file is
verified after staging and again in the same TTY-backed shell immediately before
execution. The browser remains visible only through noVNC, while the TTY exists
only so the owner can press Enter after visually confirming the dashboard. The
authoritative requirements are an exact approved payload hash, exact metadata
digest match, and no snapshot/archive/export/transfer command or credential in
the payload. If any requirement cannot be met, do not run this exception.

Whether either classifier passes or fails, the exit/signal trap preserves the
classifier status while running the compensating teardown helper and changes
the result to failure if teardown fails. Close the tunnel after that helper's
independent residue readbacks complete. Cleanup begins directly with the bounded
helper; it performs no preliminary SSH call that could delay mandatory
compensation. Successful VM-absence readback is the proof that neither the
staged `/run` payload nor profile survived. Signals are ignored only while
compensating teardown runs, so Node cannot be interrupted between resource
attempts or final readbacks. Normal signal handling is restored immediately
after that boundary. Interrupting a later postcondition records no result while
leaving the already-proven-absent temporary resources fail closed.

Before the block returns the preserved diagnostic status, it executes the
complete containment envelope in the protected operator session: the ordinary
stable-egress verifier proves zero NAT mappings and private service, Job, and
project IAM; the canonical Cloud Run execution inventory is compared
byte-for-byte with the pinned baseline of exactly 11 historical completed and
zero active executions; the checked-in sanitized operational-envelope collector
proves rollout-off and compares queue/request counts and ID/status-only
fingerprints with their zero-active baseline; the hosted billing-disabled
verifier runs; and production snapshot generation, size, and full bucket IAM
are compared unchanged, including the full canonical bindings-and-etag document
returned by gcloud 558 and every returned binding condition. Last, three
timestamp-only request-log lookups across a bounded 30-second settling window
require empty JSON arrays for the fixed Cloud Run service. Any failed or
unreadable check overrides the classifier result and keeps both hosted probes
and all provider transmission blocked.

Do not proceed to export, transfer, seeding, or either hosted probe from this
exception. A future actual credential recovery still starts at the full
destructive revocation ceremony below; classifier-only success cannot satisfy
or shorten any of its gates.

### Full credential recovery ceremony (separately authorized)

Do not begin the destructive ceremony or open the provider without its exact
OVD-410 authorization. The OVD-420 control must already pass with the reviewed
production hostname-policy digest, but that infrastructure readiness neither
authorizes provider interaction nor relaxes any revocation, deletion, transfer,
or reseed gate below.

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
profile. Copy the already validated digest from the original dedicated operator
shell and paste that exact value at the prompt below; do not derive trust from
the recovery host, its metadata, or its installed policy state. The command
opens only the interactive login/dashboard flow. Images that contain the
recovery orchestrator also perform the guarded closed-browser cold relaunch
before returning success. The container shares the dedicated temporary
host's IPC namespace so Camoufox's X11 shared-memory frames reach the host-owned
virtual display; do not reuse this command on a multi-tenant host.

```bash
set -euo pipefail

OVD410_WORKER_IMAGE="$(curl -fsS \
  -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/ovd410-worker-image)"
read -r -p 'Paste the operator-validated policy SHA-256: ' OVD420_RECOVERY_EGRESS_POLICY_SHA256
printf '%s' "$OVD420_RECOVERY_EGRESS_POLICY_SHA256" | grep -Eq '^[0-9a-f]{64}$'
export OVD420_RECOVERY_EGRESS_POLICY_SHA256

sudo --preserve-env=OVD420_RECOVERY_EGRESS_POLICY_SHA256 \
  /usr/local/sbin/ovd420-recovery-egress-control launch \
  full-recovery \
  "$OVD410_WORKER_IMAGE" \
  /var/lib/ovd410-credential
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

# The containment preflight recorded whether IAP was initially disabled. Do not
# disable the API unless the operator has a current session-specific or standing
# pre-beta confirmation of no independent project use. Otherwise leave the API
# enabled and record why.
GOOGLE_CLOUD_PROJECT=overdrafter-worker-9133 \
node scripts/teardown-ovd410-recovery-host.mjs
```

The helper compensates each resource independently: VM, firewall, repository
binding, recovery service account, and conditionally IAP. An absent resource or
one failed cleanup does not skip later cleanup. It then performs independent
list/policy/API readbacks and exits nonzero if any temporary residue remains or
any absence proof fails. Rerunning it is safe. IAP is disabled only when the
preflight recorded `DISABLED` and the no-independent-use confirmation is
`TRUE`; otherwise it must remain enabled and the operator must record why.

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
