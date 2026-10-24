# OVD-517 — read-only post-build preflight refresh

Captured 2026-09-23 00:49–00:52 UTC, after the build-only attestation. This is a time-stamped observation, not an OVD-419 pre-mutation verdict or release authorization. No production resource or database was changed.

| Gate | Observation | Disposition at capture |
| --- | --- | --- |
| Production migration head | Supabase listed 106 migrations ending at `20260905233435`; the checkout still has five later September 10 migration files. The four OVD-418 migrations remain in the installed history. | OVD-418 presence retained; five source migrations still pending. Do not infer new-head compatibility. |
| Commercial controls and queues | At `2026-09-23 00:49:27 UTC`, all four named rollout controls were `false`; active `work_queue` and `quote_requests` counts were each zero. | Pass at capture only. |
| Job/Service rollback baseline | Both still referenced `sha256:3dd67a3ce58817417d94da3b580c1eb99cdfdf9aa9d9ed2317c535ad69bf0daf`. Job resource version `AAZbIWO5L6M`, Service resource version `AAZbIWLoUVo`; Service `WORKER_BUILD_VERSION` was `25452595367f81d7b46bda960020ecd6aefb153e`. Neither resource used the new candidate digest. | Baseline parity at capture. Tokens must be recaptured before any mutation. |
| Probe execution inventory | Full CLI list, limit 1000, contained 20 historical executions. Every entry had a completion time; the latest completion was `2026-09-10T13:59:06.807506Z`. | Zero active in that complete list at capture. |
| Snapshot | Job and Service referenced the same existing bucket/object. Two metadata reads agreed on nonempty generation, metageneration and etag at `2026-09-23T00:51:40.144Z`. Exact private identity was not retained in this public packet. | Metadata stability at capture; recapture exact private binding at admission. |
| Stable egress | Repository verifier using pinned `ovd410-production-v1` contract exited 0: private Service, bounded Job, VPC, routes, and manual-address NAT controls matched. | Pass at capture only. |
| Global release ownership | Not re-inventoried across all hosts/nondefault lock locations. | Unknown; no sole-owner claim. |
| Security/performance advisors | Earlier WARN findings were not causally compared with the accepted baseline in this refresh. | Unknown release disposition. |

The qualified candidate digest is `sha256:197e36e9aabfff75ed169df0c0853d0194ce316400f30af8acd49029e5133b0e`; the Job/Service baseline remains unchanged. Before any OVD-419 Job or Service replacement, obtain separate exact release authority and recapture every required predicate immediately, including pending-migration disposition, advisor causality, snapshot identity, ownership, resource versions, queues, execution inventory, rollout controls and egress. Neither this refresh nor the consumed build-only approval authorizes a deployment or no-upload probe.
