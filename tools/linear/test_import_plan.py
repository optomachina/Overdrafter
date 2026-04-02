import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

from tools.linear.import_plan import load_seed, plan_items, render_report


class FakeLinearCLI:
    def __init__(self) -> None:
        self._issues = {
            "OVD-23": {
                "id": "issue-parent",
                "identifier": "OVD-23",
                "title": "Horizon 2 — Expand Manufacturing Workspace Capabilities",
                "url": "https://linear.example/OVD-23",
                "state": {"name": "Todo", "type": "unstarted"},
                "project": {"id": "project-symphony", "name": "Symphony"},
                "labels": {"nodes": []},
                "parent": None,
            },
            "OVD-134": {
                "id": "issue-ovd-134",
                "identifier": "OVD-134",
                "title": "Add vendor capability profile model",
                "url": "https://linear.example/OVD-134",
                "state": {"name": "Todo", "type": "unstarted"},
                "project": {"id": "project-symphony", "name": "Symphony"},
                "labels": {"nodes": []},
                "parent": {
                    "identifier": "OVD-23",
                    "title": "Horizon 2 — Expand Manufacturing Workspace Capabilities",
                },
            },
            "OVD-135": {
                "id": "issue-ovd-135",
                "identifier": "OVD-135",
                "title": "Seed lasercut vendor records and heuristics",
                "url": "https://linear.example/OVD-135",
                "state": {"name": "Todo", "type": "unstarted"},
                "project": {"id": "project-symphony", "name": "Symphony"},
                "labels": {"nodes": []},
                "parent": {
                    "identifier": "OVD-23",
                    "title": "Horizon 2 — Expand Manufacturing Workspace Capabilities",
                },
            },
        }

    def label_list(self):
        names = [
            "sub-backlog",
            "roadmap-only",
            "draft",
            "next",
            "later",
            "now",
            "spike",
            "quotes",
            "product-foundation",
            "workspace",
            "mobile",
            "desktop",
            "plugins",
            "revision-control",
            "review",
            "horizon-2",
            "horizon-1",
            "horizon-3",
            "horizon-4",
            "horizon-5",
            "horizon-6",
            "roadmap",
            "agent-workflow",
            "testing",
            "ci",
            "docs",
            "repo-hygiene",
            "Feature",
            "Bug",
            "Improvement",
            "free-tier",
            "paid-tier",
            "enterprise",
        ]
        return [{"id": name, "name": name} for name in names]

    def team_lookup(self, team_key: str):
        return {"id": "team-ovd", "key": team_key, "states": {"nodes": []}}

    def issue_by_identifier(self, identifier: str):
        return self._issues.get(identifier)

    def issues_by_title(self, project_id: str, title: str):
        return [
            issue
            for issue in self._issues.values()
            if issue["project"]["id"] == project_id and issue["title"] == title
        ]


class ImportPlanTest(unittest.TestCase):
    def setUp(self) -> None:
        full_seed = load_seed(Path("planning/linear_seed.yaml"))
        self.seed = deepcopy(full_seed)
        self.seed["items"] = [
            item
            for item in self.seed["items"]
            if item["key"] in {
                "horizon-2-parent",
                "vendor-capability-profile-model",
                "seed-vendor-records",
            }
        ]
        self.projects_by_name = {
            "Symphony": {"id": "project-symphony", "name": "Symphony"},
            "Symphony Sub-Backlog": {"id": "project-sub-backlog", "name": "Symphony Sub-Backlog"},
            "OverDrafter North Star Implementation": {
                "id": "project-north-star",
                "name": "OverDrafter North Star Implementation",
            },
        }
        self.args = SimpleNamespace(mode="sync", include_sub_backlog=False)

    def test_vendor_capability_profile_is_planned_as_update_for_existing_issue(self) -> None:
        planned, _label_state = plan_items(self.seed, FakeLinearCLI(), self.args, self.projects_by_name)

        entry = next(item for item in planned if item.key == "vendor-capability-profile-model")

        self.assertEqual(entry.action, "update")
        self.assertEqual(entry.reason, "existing issue OVD-134")
        self.assertEqual(entry.existing_issue, "OVD-134")
        self.assertEqual(entry.project, "Symphony")
        self.assertEqual(entry.parent, "OVD-23")
        self.assertEqual(entry.state, "Todo")
        self.assertEqual(
            entry.labels,
            ["next", "quotes", "product-foundation", "horizon-2", "Feature", "free-tier"],
        )

    def test_vendor_capability_profile_report_uses_todo_state(self) -> None:
        planned, _label_state = plan_items(self.seed, FakeLinearCLI(), self.args, self.projects_by_name)

        report = render_report(
            self.seed,
            planned,
            self.projects_by_name,
            {},
            live=False,
            mode="sync",
            include_sub_backlog=False,
        )

        self.assertIn("### Add vendor capability profile model", report)
        self.assertIn("- Action: `update`", report)
        self.assertIn("- Existing issue: `OVD-134`", report)
        self.assertIn("- Parent: `OVD-23`", report)
        self.assertIn("- State: `Todo`", report)

    def test_seed_vendor_records_is_planned_as_update_for_existing_issue(self) -> None:
        planned, _label_state = plan_items(self.seed, FakeLinearCLI(), self.args, self.projects_by_name)

        entry = next(item for item in planned if item.key == "seed-vendor-records")

        self.assertEqual(entry.action, "update")
        self.assertEqual(entry.reason, "existing issue OVD-135")
        self.assertEqual(entry.existing_issue, "OVD-135")
        self.assertEqual(entry.project, "Symphony")
        self.assertEqual(entry.parent, "OVD-23")
        self.assertEqual(entry.state, "Todo")
        self.assertEqual(
            entry.labels,
            ["next", "quotes", "horizon-2", "Feature", "free-tier"],
        )

    def test_seed_vendor_records_report_uses_update_action_and_parent(self) -> None:
        planned, _label_state = plan_items(self.seed, FakeLinearCLI(), self.args, self.projects_by_name)

        report = render_report(
            self.seed,
            planned,
            self.projects_by_name,
            {},
            live=False,
            mode="sync",
            include_sub_backlog=False,
        )

        self.assertIn("### Seed lasercut vendor records and heuristics", report)
        self.assertIn("- Action: `update`", report)
        self.assertIn("- Existing issue: `OVD-135`", report)
        self.assertIn("- Parent: `OVD-23`", report)
        self.assertIn("- State: `Todo`", report)


if __name__ == "__main__":
    unittest.main()
