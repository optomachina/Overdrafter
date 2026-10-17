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


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in {"-h", "--help"}:
        print("Usage: land_watch.py")
        print("Waits for the current branch PR to become mergeable via gh pr view.")
        return 0

    deadline = time.time() + 20 * 60

    while time.time() < deadline:
        pr = read_pr()
        state = pr.get("state")
        draft = pr.get("isDraft")
        merge_state = pr.get("mergeStateStatus")
        checks = pr.get("statusCheckRollup") or []

        if state == "MERGED":
            print(f"PR already merged: {pr['url']}")
            return 0

        if draft:
            print("PR is still draft; waiting for it to become ready for review.")
            time.sleep(15)
            continue

        failing, pending = classify_checks(checks)

        if failing:
            print("PR checks are failing:")
            for item in failing:
                print(f"  - {item}")
            return 1

        if merge_state in ("BLOCKED", "DIRTY", "UNKNOWN"):
            print(f"PR not mergeable yet: {merge_state}")
            time.sleep(15)
            continue

        if pending:
            print("Waiting for PR checks:")
            for item in pending:
                print(f"  - {item}")
            time.sleep(15)
            continue

        print(f"PR looks mergeable: {pr['url']}")
        return 0

    print("Timed out waiting for the PR to become mergeable.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
