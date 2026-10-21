#!/usr/bin/env python3
import json
import subprocess
import sys
import time


def read_pr():
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                "--json",
                "number,url,state,isDraft,mergeStateStatus,statusCheckRollup",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip() if exc.stderr else "unknown gh error"
        print(f"Unable to inspect the current PR with gh: {stderr}", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(result.stdout)


def classify_checks(checks):
    """Classify GraphQL CheckRun and StatusContext entries without I/O."""
    failing, pending = [], []
    if not checks:
        # Nothing registered yet (typical right after a push or update-branch):
        # wait, never report "looks mergeable".
        pending.append("no checks reported yet")
    for check in checks:
        name = check.get("name") or check.get("context") or "unnamed-check"
        if "context" in check and "conclusion" not in check:
            state = check.get("state")
            if state in ("PENDING", "EXPECTED"):
                pending.append(name)
            elif state != "SUCCESS":
                failing.append(f"{name}: {state}")
        elif check.get("status") != "COMPLETED" or check.get("conclusion") in (None, ""):
            pending.append(name)
        elif check["conclusion"] != "SUCCESS":
            failing.append(f"{name}: {check['conclusion']}")
    return failing, pending


def evaluate(pr):
    """Return a verdict and explanation without I/O."""
    state = pr.get("state")
    if state == "MERGED":
        return "merged", "PR already merged"
    if state == "CLOSED":
        return "stop", "PR is closed"
    if state != "OPEN":
        return "stop", "unknown PR state"
    merge_state = pr.get("mergeStateStatus")
    if merge_state == "BEHIND":
        return "stop", "PR is behind main; run land_strict_merge.sh to update it"
    if merge_state == "DIRTY":
        return "stop", "merge conflict"
    if merge_state not in {"CLEAN", "HAS_HOOKS", "UNSTABLE", "DRAFT", "BLOCKED", "UNKNOWN"}:
        return "stop", "unknown merge state"
    failing, pending = classify_checks(pr.get("statusCheckRollup") or [])
    if failing:
        return "stop", "PR checks are failing: " + ", ".join(failing)
    if pr.get("isDraft") is not False or merge_state == "DRAFT":
        return "wait", "PR is still draft or draft state is unknown"
    if merge_state in {"BLOCKED", "UNKNOWN"}:
        return "wait", "PR not mergeable yet: " + merge_state
    if pending:
        return "wait", "Waiting for PR checks: " + ", ".join(pending)
    return "mergeable", "PR looks mergeable"


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in {"-h", "--help"}:
        print("Usage: land_watch.py")
        print("Waits for the current branch PR to become mergeable via gh pr view.")
        return 0
    deadline = time.time() + 20 * 60
    while time.time() < deadline:
        pr = read_pr()
        verdict, message = evaluate(pr)
        print(f"{message}: {pr.get('url')}" if verdict in {"mergeable", "merged"} else message)
        if verdict in {"mergeable", "merged"}:
            return 0
        if verdict == "stop":
            return 1
        time.sleep(15)

    print("Timed out waiting for the PR to become mergeable.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
