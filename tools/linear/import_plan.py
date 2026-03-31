#!/usr/bin/env python3
"""Sync planning/linear_seed.yaml into Linear using the local Linear CLI.

The seed file is authored as YAML 1.2 JSON-compatible syntax so it can be
parsed with Python's stdlib json module while still remaining valid YAML.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = ROOT / "planning" / "linear_seed.yaml"
DEFAULT_REPORT = ROOT / "planning" / "linear_import_report.md"


class LinearCommandError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import or reconcile planning/linear_seed.yaml with Linear via the local CLI."
    )
    parser.add_argument(
        "--input",
        default=str(DEFAULT_INPUT),
        help="Path to the JSON-compatible YAML seed file.",
    )
    parser.add_argument(
        "--report",
        default=str(DEFAULT_REPORT),
        help="Path to the markdown report file to write.",
    )
    parser.add_argument(
        "--mode",
        choices=["sync", "create", "update"],
        default="sync",
        help="sync=create missing + update open, create=only create missing, update=only update existing",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Apply changes to Linear. Dry-run is the default.",
    )
    parser.add_argument(
        "--include-sub-backlog",
        action="store_true",
        help="Allow deferred items to be imported into the configured sub-backlog project.",
    )
    return parser.parse_args()


def load_seed(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text()
    except FileNotFoundError as exc:
        raise SystemExit(f"Seed file not found: {path}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"{path} must be valid YAML 1.2 JSON-compatible syntax. Parse error: {exc}"
        ) from exc

    if not isinstance(data, dict):
        raise SystemExit("Seed root must be an object.")
    if "meta" not in data or "items" not in data:
        raise SystemExit("Seed must contain top-level meta and items keys.")
    data.setdefault("projects", [])
    return data


def to_cli_flag(name: str, value: Any) -> list[str]:
    return [name, str(value)]


def run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    capture_output: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd,
        cwd=cwd or ROOT,
        text=True,
        capture_output=capture_output,
    )
    if check and result.returncode != 0:
        stderr = result.stderr.strip() or result.stdout.strip()
        raise LinearCommandError(f"Command failed ({result.returncode}): {' '.join(cmd)}\n{stderr}")
    return result


class LinearCLI:
    def __init__(self, workspace: str | None):
        self.workspace = workspace
        self._workspace_disabled = bool(os.environ.get("LINEAR_API_KEY"))

    def _base(self) -> list[str]:
        base = ["linear"]
        if self.workspace and not self._workspace_disabled:
            base.extend(["--workspace", self.workspace])
        return base

    def json_command(self, args: list[str]) -> Any:
        result = run(self._base() + args)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise LinearCommandError(
                f"Expected JSON from command {' '.join(args)} but got:\n{result.stdout}"
            ) from exc

    def api(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        args = ["api", query]
        if variables:
            args.extend(["--variables-json", json.dumps(variables)])
        payload = self.json_command(args)
        if payload.get("errors"):
            raise LinearCommandError(
                f"Linear API error for query {query!r}: {json.dumps(payload['errors'], indent=2)}"
            )
        return payload["data"]

    def project_list(self) -> list[dict[str, Any]]:
        data = self.api(
            """
            query {
              projects(first: 100) {
                nodes {
                  id
                  name
                  description
                  slugId
                }
              }
            }
            """
        )
        return data["projects"]["nodes"]

    def label_list(self) -> list[dict[str, Any]]:
        data = self.api(
            """
            query {
              issueLabels(first: 200) {
                nodes {
                  id
                  name
                  color
                  description
                  team {
                    id
                    key
                    name
                  }
                }
              }
            }
            """
        )
        return data["issueLabels"]["nodes"]

    def team_lookup(self, team_key: str) -> dict[str, Any]:
        data = self.api(
            """
            query {
              teams {
                nodes {
                  id
                  key
                  name
                  states {
                    nodes {
                      id
                      name
                      type
                    }
                  }
                }
              }
            }
            """,
        )
        for node in data["teams"]["nodes"]:
            if node["key"] == team_key:
                return node
        raise LinearCommandError(f"Team {team_key!r} not found via Linear CLI.")

    def issue_by_identifier(self, identifier: str) -> dict[str, Any] | None:
        data = self.api(
            """
            query($id:String!){
              issue(id:$id){
                id
                identifier
                title
                url
                state { name type }
                project { id name }
                labels { nodes { name } }
                parent { identifier title }
              }
            }
            """,
            {"id": identifier},
        )
        return data.get("issue")

    def issues_by_title(self, project_id: str, title: str) -> list[dict[str, Any]]:
        data = self.api(
            """
            query($project:ID!,$title:String!){
              issues(
                filter:{ project: { id: { eq: $project } }, title: { eq: $title } },
                first: 10
              ){
                nodes {
                  id
                  identifier
                  title
                  url
                  state { name type }
                  project { id name }
                  labels { nodes { name } }
                  parent { identifier title }
                }
              }
            }
            """,
            {"project": project_id, "title": title},
        )
        return data["issues"]["nodes"]

    def create_label(self, name: str, color: str | None, description: str | None) -> None:
        cmd = self._base() + ["label", "create", "--name", name]
        if color:
            cmd += ["--color", color]
        if description:
            cmd += ["--description", description]
        run(cmd)

    def create_project(self, spec: dict[str, Any]) -> None:
        cmd = self._base() + [
            "project",
            "create",
            "--name",
            spec["name"],
            "--team",
            spec["team"],
            "--status",
            spec.get("status", "backlog"),
        ]
        if spec.get("description"):
            cmd += ["--description", spec["description"]]
        run(cmd)

    def update_project(self, project_id: str, spec: dict[str, Any]) -> None:
        cmd = self._base() + ["project", "update", project_id]
        if spec.get("description"):
            cmd += ["--description", spec["description"]]
        if spec.get("status"):
            cmd += ["--status", spec["status"]]
        run(cmd)

    def _state_id_for_name(self, team: dict[str, Any], state_name: str) -> str:
        for state in team.get("states", {}).get("nodes", []):
            if state["name"] == state_name:
                return state["id"]
        raise LinearCommandError(
            f"State {state_name!r} not found for team {team['key']}."
        )

    def update_issue(
        self,
        issue_id: str,
        team: dict[str, Any],
        project_id: str,
        item: dict[str, Any],
        description: str,
        parent_id: str | None,
        label_ids: list[str],
    ) -> dict[str, Any]:
        input_payload: dict[str, Any] = {
            "title": item["title"],
            "description": description,
            "priority": item["priority"],
            "estimate": item["estimate"],
            "projectId": project_id,
            "teamId": team["id"],
            "stateId": self._state_id_for_name(team, item["state"]),
            "labelIds": label_ids,
        }
        if parent_id:
            input_payload["parentId"] = parent_id
        data = self.api(
            """
            mutation($id:String!, $input: IssueUpdateInput!) {
              issueUpdate(id: $id, input: $input) {
                success
                issue {
                  id
                  identifier
                  title
                  url
                }
              }
            }
            """,
            {"id": issue_id, "input": input_payload},
        )
        return data["issueUpdate"]["issue"]

    def create_issue(
        self,
        team: dict[str, Any],
        project_id: str,
        item: dict[str, Any],
        description: str,
        parent_id: str | None,
        label_ids: list[str],
    ) -> dict[str, Any]:
        input_payload: dict[str, Any] = {
            "title": item["title"],
            "description": description,
            "priority": item["priority"],
            "estimate": item["estimate"],
            "projectId": project_id,
            "teamId": team["id"],
            "stateId": self._state_id_for_name(team, item["state"]),
            "labelIds": label_ids,
        }
        if parent_id:
            input_payload["parentId"] = parent_id
        data = self.api(
            """
            mutation($input: IssueCreateInput!) {
              issueCreate(input: $input) {
                success
                issue {
                  id
                  identifier
                  title
                  url
                }
              }
            }
            """,
            {"input": input_payload},
        )
        return data["issueCreate"]["issue"]

    def add_relation(self, source_issue_id: str, relation_type: str, target_issue_id: str) -> None:
        linear_relation_type = "blocks" if relation_type == "blocked-by" else relation_type
        try:
            self.api(
                """
                mutation($input: IssueRelationCreateInput!) {
                  issueRelationCreate(input: $input) {
                    success
                  }
                }
                """,
                {
                    "input": {
                        "issueId": source_issue_id,
                        "relatedIssueId": target_issue_id,
                        "type": linear_relation_type,
                    }
                },
            )
        except LinearCommandError as exc:
            message = str(exc).lower()
            if "already exists" in message or "duplicate" in message:
                return
            raise


def markdown_bullets(items: list[str]) -> str:
    if not items:
        return "- None"
    return "\n".join(f"- {item}" for item in items)


def build_description(item: dict[str, Any]) -> str:
    parts = [
        f"## Problem\n\n{item['problem']}",
        f"## Outcome\n\n{item['outcome']}",
        f"## Why now\n\n{item['whyNow']}",
        f"## Scope\n\n{markdown_bullets(item.get('scope', []))}",
        f"## Out of scope\n\n{markdown_bullets(item.get('outOfScope', []))}",
        f"## Implementation notes\n\n{markdown_bullets(item.get('implementationNotes', []))}",
        f"## Acceptance criteria\n\n{markdown_bullets(item.get('acceptanceCriteria', []))}",
        f"## Testing\n\n{markdown_bullets(item.get('testing', []))}",
    ]

    deps = []
    for dep in item.get("dependencies", []):
        key = dep.get("key", "<missing-key>")
        rel = dep.get("type", "blocked-by")
        deps.append(f"{rel}: {key}")
    parts.append(f"## Dependencies\n\n{markdown_bullets(deps)}")
    parts.append(f"## Tier gating\n\n{item.get('tierGating', 'free-tier')}")
    parts.append(f"## Metrics impact\n\n{markdown_bullets(item.get('metricsImpact', []))}")
    parts.append(f"## Source context\n\n{markdown_bullets(item.get('sourceContext', []))}")

    notes = item.get("notesForFutureSplit")
    if notes:
        parts.append(f"## Notes for future split\n\n{markdown_bullets(notes)}")

    return "\n\n".join(parts).strip() + "\n"


@dataclass
class PlannedItem:
    key: str
    title: str
    action: str
    reason: str
    project: str
    state: str
    labels: list[str]
    priority: int
    estimate: int
    parent: str | None
    existing_issue: str | None = None
    existing_issue_id: str | None = None
    url: str | None = None
    dependencies: list[dict[str, Any]] | None = None
    item: dict[str, Any] | None = None


def should_import(item: dict[str, Any], include_sub_backlog: bool) -> bool:
    policy = item.get("importPolicy", "sync")
    if policy == "report-only":
        return False
    if policy == "deferred":
        return include_sub_backlog
    return True


def relation_preview(dep: dict[str, Any]) -> str:
    return f"{dep.get('type', 'blocked-by')} {dep.get('key', '<missing-key>')}"


def plan_items(
    seed: dict[str, Any],
    cli: LinearCLI,
    args: argparse.Namespace,
    projects_by_name: dict[str, Any],
) -> tuple[list[PlannedItem], dict[str, Any]]:
    team_key = seed["meta"]["team"]
    labels_by_name = {label["name"]: label for label in cli.label_list()}
    team = cli.team_lookup(team_key)

    allowed_labels = {entry["name"]: entry for entry in seed.get("labelPolicy", {}).get("allowCreate", [])}
    for item in seed["items"]:
        for label in item.get("labels", []):
            if label not in labels_by_name and label not in allowed_labels:
                raise LinearCommandError(
                    f"Item {item['key']} references label {label!r}, which does not exist and is not in the allowlist."
                )

    planned: list[PlannedItem] = []
    resolved_identifiers: dict[str, str] = {}

    for item in seed["items"]:
        policy = item.get("importPolicy", "sync")
        target_project = item.get("targetProject") or seed["meta"]["defaultProject"]
        if policy == "deferred" and args.include_sub_backlog:
            target_project = seed["meta"]["subBacklogProject"]
        if target_project not in projects_by_name:
            raise LinearCommandError(f"Target project {target_project!r} not found in Linear.")

        project_id = projects_by_name[target_project]["id"]
        parent_identifier = None
        if item.get("parentKey"):
            parent_identifier = resolved_identifiers.get(item["parentKey"])
        existing_issue = None
        reason = ""

        if item.get("existingIssue"):
            existing_issue = cli.issue_by_identifier(item["existingIssue"])
            if existing_issue is None:
                raise LinearCommandError(
                    f"Item {item['key']} points at missing issue {item['existingIssue']}."
                )
        else:
            matches = cli.issues_by_title(project_id, item["title"])
            if matches:
                existing_issue = matches[0]

        if existing_issue:
            resolved_identifiers[item["key"]] = existing_issue["identifier"]

        importable = should_import(item, args.include_sub_backlog)
        state_type = existing_issue["state"]["type"] if existing_issue else None
        existing_identifier = existing_issue["identifier"] if existing_issue else None
        existing_url = existing_issue["url"] if existing_issue else None

        if not importable:
            action = "skip"
            if policy == "report-only":
                reason = "report-only overlap"
            else:
                reason = "deferred; excluded from default live import"
        elif existing_issue and state_type == "completed":
            action = "skip"
            reason = f"existing issue {existing_identifier} is completed"
        elif existing_issue and args.mode == "create":
            action = "skip"
            reason = f"duplicate match {existing_identifier}; create mode does not update"
        elif existing_issue and args.mode in {"sync", "update"}:
            action = "update"
            reason = f"existing issue {existing_identifier}"
        elif not existing_issue and args.mode == "update":
            action = "skip"
            reason = "update mode only; no existing issue matched"
        elif not existing_issue and args.mode in {"sync", "create"}:
            action = "create"
            reason = "missing from target project"
        else:
            action = "skip"
            reason = "no applicable action"

        planned.append(
            PlannedItem(
                key=item["key"],
                title=item["title"],
                action=action,
                reason=reason,
                project=target_project,
                state=item["state"],
                labels=item.get("labels", []),
                priority=item["priority"],
                estimate=item["estimate"],
                parent=parent_identifier,
                existing_issue=existing_identifier,
                existing_issue_id=existing_issue["id"] if existing_issue else None,
                url=existing_url,
                dependencies=item.get("dependencies", []),
                item=item,
            )
        )

    return planned, {"labels": labels_by_name, "allowed": allowed_labels, "team": team}


def ensure_projects(
    cli: LinearCLI,
    seed: dict[str, Any],
    projects_by_name: dict[str, Any],
    *,
    live: bool,
) -> dict[str, dict[str, Any]]:
    resolved = dict(projects_by_name)
    for spec in seed.get("projects", []):
        existing = resolved.get(spec["name"])
        policy = spec.get("importPolicy", "sync")
        if existing:
            if live and policy != "report-only":
                cli.update_project(existing["id"], spec)
                resolved = {project["name"]: project for project in cli.project_list()}
            continue
        if policy == "report-only":
            raise LinearCommandError(
                f"Seed expects project {spec['name']!r} to exist, but Linear did not return it."
            )
        if live:
            cli.create_project(spec)
            resolved = {project["name"]: project for project in cli.project_list()}
        else:
            resolved[spec["name"]] = {
                "id": None,
                "name": spec["name"],
                "url": None,
                "_plannedCreate": True,
            }
    return resolved


def ensure_labels(
    cli: LinearCLI,
    planned: list[PlannedItem],
    label_state: dict[str, Any],
    *,
    live: bool,
) -> dict[str, dict[str, Any]]:
    labels_by_name = dict(label_state["labels"])
    allowed = label_state["allowed"]
    used_labels = {label for entry in planned for label in entry.labels}
    for label_name in sorted(used_labels):
        if label_name in labels_by_name:
            continue
        if label_name not in allowed:
            raise LinearCommandError(f"Label {label_name!r} is missing and not allowlisted.")
        if live:
            spec = allowed[label_name]
            cli.create_label(label_name, spec.get("color"), spec.get("description"))
            labels_by_name = {label["name"]: label for label in cli.label_list()}
        else:
            labels_by_name[label_name] = {
                "id": None,
                "name": label_name,
                "description": allowed[label_name].get("description"),
                "color": allowed[label_name].get("color"),
                "team": None,
                "_plannedCreate": True,
            }
    return labels_by_name


def apply_plan(
    seed: dict[str, Any],
    cli: LinearCLI,
    planned: list[PlannedItem],
    projects_by_name: dict[str, Any],
    labels_by_name: dict[str, dict[str, Any]],
    team: dict[str, Any],
    *,
    live: bool,
) -> list[PlannedItem]:
    executed: list[PlannedItem] = []
    identifiers_by_key = {
        entry.key: entry.existing_issue for entry in planned if entry.existing_issue
    }
    ids_by_key = {
        entry.key: entry.existing_issue_id for entry in planned if entry.existing_issue_id
    }

    for entry in planned:
        item = entry.item or {}
        description = build_description(item)
        parent_identifier = entry.parent
        parent_id = None
        if item.get("parentKey"):
            parent_identifier = identifiers_by_key.get(item["parentKey"]) or parent_identifier
            parent_id = ids_by_key.get(item["parentKey"])
        elif parent_identifier:
            parent_lookup = cli.issue_by_identifier(parent_identifier)
            parent_id = parent_lookup["id"] if parent_lookup else None

        label_ids = [labels_by_name[label]["id"] for label in item.get("labels", [])]
        project_id = projects_by_name[entry.project]["id"]

        if entry.action == "create" and live:
            created = cli.create_issue(team, project_id, item, description, parent_id, label_ids)
            entry.existing_issue = created["identifier"]
            entry.existing_issue_id = created["id"]
            entry.url = created["url"]
            identifiers_by_key[entry.key] = created["identifier"]
            ids_by_key[entry.key] = created["id"]
        elif entry.action == "update" and live and entry.existing_issue_id:
            updated = cli.update_issue(entry.existing_issue_id, team, project_id, item, description, parent_id, label_ids)
            entry.existing_issue = updated["identifier"]
            entry.existing_issue_id = updated["id"]
            entry.url = updated["url"]
            identifiers_by_key[entry.key] = updated["identifier"]
            ids_by_key[entry.key] = updated["id"]

        executed.append(entry)

    if live:
        for entry in executed:
            if entry.action not in {"create", "update"} or not entry.existing_issue_id:
                continue
            for dep in entry.dependencies or []:
                related_id = ids_by_key.get(dep["key"])
                if not related_id:
                    continue
                relation_type = dep.get("type", "blocked-by")
                if relation_type == "blocked-by":
                    cli.add_relation(related_id, relation_type, entry.existing_issue_id)
                else:
                    cli.add_relation(entry.existing_issue_id, relation_type, related_id)
            if entry.parent and entry.existing_issue:
                continue
            parent_key = (entry.item or {}).get("parentKey")
            if parent_key and parent_key in identifiers_by_key:
                entry.parent = identifiers_by_key[parent_key]

    return executed


def render_report(
    seed: dict[str, Any],
    planned: list[PlannedItem],
    projects_by_name: dict[str, dict[str, Any]],
    labels_by_name: dict[str, dict[str, Any]],
    *,
    live: bool,
    mode: str,
    include_sub_backlog: bool,
) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    created = sum(1 for item in planned if item.action == "create")
    updated = sum(1 for item in planned if item.action == "update")
    skipped = sum(1 for item in planned if item.action == "skip")
    planned_creates = [name for name, data in labels_by_name.items() if data.get("_plannedCreate")]
    planned_projects = [name for name, data in projects_by_name.items() if data.get("_plannedCreate")]

    lines = [
        "# Linear Import Report",
        "",
        f"- Generated: {now}",
        f"- Mode: {mode}",
        f"- Live run: {'yes' if live else 'no'}",
        f"- Included deferred sub-backlog items: {'yes' if include_sub_backlog else 'no'}",
        f"- Team: {seed['meta']['team']}",
        "",
        "## Summary",
        "",
        f"- Create: {created}",
        f"- Update: {updated}",
        f"- Skip: {skipped}",
        "",
        "## Project Resolution",
        "",
    ]

    if planned_projects:
        lines.extend(f"- Would create project `{name}`" for name in sorted(planned_projects))
    else:
        lines.extend(f"- Resolved project `{project['name']}`" for project in seed.get("projects", []))

    lines.extend([
        "",
        "## Planned Label Creation",
        "",
    ])

    if planned_creates:
        lines.extend(f"- {label}" for label in sorted(planned_creates))
    else:
        lines.append("- None")

    lines.extend(["", "## Item Actions", ""])

    for entry in planned:
        lines.append(f"### {entry.title}")
        lines.append("")
        lines.append(f"- Seed key: `{entry.key}`")
        lines.append(f"- Action: `{entry.action}`")
        lines.append(f"- Reason: {entry.reason}")
        lines.append(f"- Target project: `{entry.project}`")
        if entry.existing_issue:
            suffix = f" ([open]({entry.url}))" if entry.url else ""
            lines.append(f"- Existing issue: `{entry.existing_issue}`{suffix}")
        if entry.parent:
            lines.append(f"- Parent: `{entry.parent}`")
        lines.append(f"- State: `{entry.state}`")
        lines.append(f"- Priority / estimate: `P{entry.priority}` / `{entry.estimate}`")
        if entry.labels:
            lines.append(f"- Labels: {', '.join(f'`{label}`' for label in entry.labels)}")
        deps = entry.dependencies or []
        if deps:
            lines.append(
                f"- Dependencies: {', '.join(f'`{relation_preview(dep)}`' for dep in deps)}"
            )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    seed = load_seed(Path(args.input))
    cli = LinearCLI(seed["meta"].get("workspace"))
    initial_projects = {project["name"]: project for project in cli.project_list()}
    projects_by_name = ensure_projects(cli, seed, initial_projects, live=args.live)
    planned, label_state = plan_items(seed, cli, args, projects_by_name)
    labels_by_name = ensure_labels(cli, planned, label_state, live=args.live)
    executed = apply_plan(
        seed,
        cli,
        planned,
        projects_by_name,
        labels_by_name,
        label_state["team"],
        live=args.live,
    )
    report = render_report(
        seed,
        executed,
        projects_by_name,
        labels_by_name,
        live=args.live,
        mode=args.mode,
        include_sub_backlog=args.include_sub_backlog,
    )
    Path(args.report).write_text(report)
    print(report)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LinearCommandError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
