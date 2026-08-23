# OVD-410 Stable Xometry Egress

Last updated: August 22, 2026

This workflow provisions and verifies the single cost-governed outbound path
owned by `OVD-410`. It does not authorize Xometry login, profile rotation,
snapshot replacement, authentication-Job execution, CAD upload, quote creation,
ordering, or the separate `OVD-408` production release.

As built on August 22, 2026, the fixed resources below exist, the worker and
authentication Job are bound to the same all-traffic path, and the sanitized
live verifier passes. No provider-facing probe has run on this path, so the
source-network hypothesis and hosted authentication integrity remain unproven.

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

After a pass, recheck every rollout and billing control, zero queued/running
work, snapshot generation and size, private invocation, service scaling, Job
retry controls, and the retained image identity. Provider work remains blocked.

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
