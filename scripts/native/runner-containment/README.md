# Runner lifecycle and Windows Job Object containment

This directory defines a source-only containment boundary for a future Windows
engineering runner. It does not activate a runner, launch a process, call CAD,
or establish Windows behavior. The checked-in Workstation packet always refuses
execution until a later exact admission changes that boundary.

## Portable lifecycle

`runner-lifecycle.mjs` validates a closed sequence:

```text
prepared
  -> intent_durable
  -> job_configured
  -> child_created_suspended_and_assigned
  -> child_identity_durable
  -> assignment_verified_durable
  -> child_resumed
  -> terminal_observed
  -> job_empty_proved
  -> finalized
```

Invalid ordering is `process_uncertain`. Cleanup remains permitted after a
post-creation persistence failure, but persistence failure can never produce an
eligible result. Operation, persistence, cleanup, and evidence eligibility are
independent fields. Invalid transitions irreversibly latch uncertainty. Eligible
evidence must bind the lifecycle attempt and fence to all six ordered journal
events. The public projection is value-free and always reports this implementation
as source-only and runtime-unqualified.

The Windows source advertises suspended creation, creation-time Job assignment,
retained process and Job handles, inherited descendant containment, whole-Job
termination, kill-on-owner-close, membership query, creation-time identity, and
durable-journal intent. It explicitly does not advertise filesystem, network,
UI, credential or malware isolation, SolidWorks qualification, production
admission, or runtime qualification.

## Windows source contract

`WindowsJobObjectRunner.cs` uses an unnamed non-inheritable Job Object. It sets
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and a three-process active limit without
either breakaway flag. It writes launch intent before calling `CreateProcessW`.
The Windows 10+ `PROC_THREAD_ATTRIBUTE_JOB_LIST` places the new process into the
Job as part of creation, while `CREATE_SUSPENDED` prevents its primary thread
from running. The backend records identity through the retained process handle,
verifies membership, persists assignment evidence, and only then resumes the
primary thread.

The request cannot select an executable, arguments, working directory, or time
limit. It maps four closed scenario names to the adjacent
`SyntheticChildTree.exe`, an already-existing fresh attempt directory, and fixed
deadlines. The helper file is held open against replacement from hashing through
process creation and identity verification. Attempt and helper paths must resolve
on a fixed local drive with no reparse point in their ancestry; rooted-relative,
UNC, removable, and network paths are rejected before launch. The child receives
only a synthetic Unicode environment containing the admitted local Windows
directory as `SystemRoot` and `WINDIR`.

The backend never finds or terminates by PID or process name. Normal and
emergency tree termination use only the retained Job handle. The Job handle is
kept until the root is terminal and a complete, non-truncated membership query
proves the Job empty. A failed or oversized membership query is uncertainty,
not absence. If journaling fails after creation, further normal effects stop but
exact-handle cleanup remains allowed.

Default Job inheritance covers descendants created through ordinary
`CreateProcess` behavior. It does not cover work delegated through COM, WMI,
services, shell brokers, or another out-of-process launcher. Those facilities
are excluded from this source contract. The backend advertises no general
credential-isolation capability: the fixed synthetic environment is specific to
this closed helper and does not qualify an arbitrary or production workload.

Journal snapshots are private evidence. Each fixed record binds attempt, fence,
worker, boot, runtime and job digests, sequence, prior digest, event and bounded
event-specific flat string fields. A cross-language golden vector fixes canonical
field order and hashing. One exclusive owner lock is retained for the full attempt;
each replacement verifies the expected prior snapshot. The next snapshot is
written to a fresh same-directory file with write-through plus `Flush(true)`, then
moved or atomically replaces the previous snapshot. Source inspection does not
prove those durability semantics on a real Windows filesystem.

Primary contracts:

- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- [process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
- [creation-time Job List attribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [kill on Job close](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
- [Job membership list](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list)
- [process creation time](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)

## Portable source checks

These commands launch no child other than the repository's ordinary Node test
runner and make no Windows API call:

```sh
node --test --test-concurrency=1 \
  scripts/native/runner-containment/runner-lifecycle.test.mjs \
  scripts/native/runner-containment/test-source-contract.mjs
```

The static checks prove only that the reviewed source contains the required
calls and closed boundaries. They do not compile C#, exercise Job Objects, prove
journal durability, contain a child tree, or qualify Workstation.

## Disabled Workstation packet

`qualify-windows-job-object.ps1` throws before directory creation, compiler
lookup, source copy, compilation, or process creation. A syntactically valid
admission file or `-Qualify` flag cannot enable it in this source revision.

A future separately admitted revision may enable only five bounded case
families: single-root natural exit, three-process tree natural exit,
three-process timeout and exact-Job termination, denial of a fourth process by
the active-process limit, and journal faults around each effect boundary. It
must bind the exact Workstation host/boot, Windows build, PowerShell/compiler,
source commit/tree/file hashes, private attempt root, coordinator admission and
limits. Cases run serially with at most three helper processes, 5 seconds for
readiness, 10 seconds for ordinary completion, 5 seconds for cleanup/empty proof,
90 seconds overall, 64 KiB per journal snapshot, 128 records and 8 MiB total.

Future qualification must separately corroborate a child-limit launch denial by
its Win32 error and complete Job accounting, and prove creation-time assignment, exact
identity, descendant accounting, denied breakaway/over-cap creation, whole-tree
termination, kill-on-close, crash/fault behavior, final empty membership and
retained evidence. It authorizes no SolidWorks launch or production use.

## Preserved platform boundary

macOS remains limited to source, unit and synthetic natural-exit behavior. It
must never be used to claim actual child-tree stop containment. The earlier
macOS group-signal feasibility blocker is not retried or weakened here.
