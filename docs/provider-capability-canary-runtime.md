# Capability canary runtime and disabled deployment

This deployment helper is delivered with companion OVD-415 runtime and ledger/attention commits. The helper commit alone does not contain the executable or package script described below; integrate and verify the companion source before relying on those instructions. The combined source supplies a provider-neutral canary boundary that reuses the offline planner, shared capability classifier, sanitized observation record RPC, and attention projection. It does not grant provider access. OVD-409 owns the dashboard; this module does not expose a client API.

## Default-off entry point

`npm --prefix worker run canary:capability` (compiled container: `node dist/tools/providerCapabilityCanary.js`) requires both `CANARY_SCHEDULE_ENABLED=true` and `CANARY_TRIGGER_ENABLED=true` before considering a request. Omitted or false flags keep it disabled. Do not load production worker configuration or enabled-provider defaults into this tool.

An enabled request additionally needs separately recorded schedule and trigger authorization, bound to the exact reviewed plan/window, and an explicit reviewed no-upload probe binding. A flag or issue reference alone is not independent operator authorization. The executable's reviewed probe registry is empty until a concrete binding is separately reviewed. Default-off invocation requires no credentials, browser, session, ledger connection, or provider traffic.

The runtime uses the existing profile lifecycle lock and finite deadlines with no retry. A trusted no-upload probe must expose only sanitized capability observations, support cancellation and acknowledge cleanup. It must not select files, upload, configure a quote, mutate supplier workflow, or expose a production adapter. A timeout never licenses retry of an operation whose outcome is unknown. A hosted task timeout remains necessary to bound a process whose cancellation cannot be confirmed.

## Durable service boundaries

Before any probe, execution requires a durable single-window reservation with an allocated observation revision and reviewed admission. The existing observation RPC enforces idempotent writes but does not provide a pre-probe reservation or a revision allocator. The current-observation resolver hides noncurrent revisions; do not use its result plus one as an allocator. Neither a local profile lock nor one task/parallelism one prevents duplicate executions in separate containers.

The ledger bridge writes through `recordProviderUploadCapabilityObservation` only. It accepts the matching reserved window/revision and sanitized planner output. It never writes quote, offer, customer, task or queue rows. RPC timeout after invocation is an uncertain write outcome, not a safely retryable failure.

Attention integration delegates classification and freshness to `projectCapabilityAttention`. Durable cursor/item/intent updates require one atomic compare-and-swap boundary; stale reevaluation uses retained evidence and must deduplicate the same transition. No production in-memory store or alternate observation ledger is supplied. The existing provider-added notification table cannot serve as this cursor/outbox store.

These missing durable services and the reviewed no-upload probe are unresolved integration requirements. The source boundaries fail closed when they are absent. Synthetic tests do not qualify a live service, create operator authorization, or complete OVD-415/OVD-387.

## Review-only deployment helper

`node scripts/configure-capability-canary.mjs public-config.json` prints a JSON bundle; it never calls Google Cloud, Terraform, IAM, a browser, or a provider. The input is a closed object with `project`, `region`, `job`, `scheduler`, immutable digest-pinned `image`, distinct `runtimeServiceAccount` and `schedulerServiceAccount`, and integer `timeoutSeconds` from 1 through 60. These are explicit public resource identities, not credentials. It reads no ambient deployment defaults.

The bundle contains:

- `cloudRunJob`: a Cloud Run v1 Job manifest with one task, parallelism one, zero retries, CPU one, memory 512 MiB, the finite timeout, and both runtime gates set to false. No credentials, profile, runtime request or production environment is inherited.
- `schedulerTerraform`: a Terraform JSON resource with `paused: true`, hourly UTC cadence, zero retries, a 15-second HTTP request deadline, and an authenticated Cloud Run jobs `:run` target. It grants no IAM role. The HTTP deadline bounds submission, not job execution.

The [Cloud Run Job schema](https://docs.cloud.google.com/run/docs/reference/yaml/v1#cloud_run_job_yaml) defines the task limits. Scheduler REST [`state` is output-only](https://docs.cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs); the helper uses Terraform's [explicit `paused` configuration](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_scheduler_job) instead of presenting a fake writable REST state. No provider package is installed or applied by this helper. Terraform provider version/lock and hosted manifest validation remain deployment review work.

Even an accidentally resumed schedule reaches a disabled trigger. Creating a scheduler may involve a provider create-then-pause sequence, so the independently disabled runtime is required throughout any future installation. An infinite cron is not a finite spend authorization: any future enablement must bind a finite planner horizon/window budget, approved infrastructure budget, and explicit retirement/disable procedure. Do not enable this bundle as delivered.

## Separate operator enablement and rollback

Before any future activation, independently review the exact no-upload surface and bound adapter, durable window/revision service, atomic attention store, session ownership across hosts, cancellation/outer timeout, sanitized ledger permissions, scoped IAM, and finite plan/window budget. Record separate schedule and trigger authorization against immutable source and plan/window identities. Actual provider/session/credential/IAM/cloud actions require their own current authorization.

Disable by pausing the schedule and setting both runtime gates false; deny new reservations and revoke the canary's permission as part of the separately authorized operational procedure. Treat in-flight or uncertain writes as unknown until reconciled. Retain observations, reservation/audit receipts, attention cursor history and transition records. Do not delete audit data or clear uncertain claims as rollback cleanup.
