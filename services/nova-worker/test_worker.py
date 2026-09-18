import unittest

from worker import PlanError, build_prompt, validate_plan


def plan():
    return {
        "run_id": "run-1",
        "session_id": "s-001",
        "persona": {
            "persona_id": "p-001",
            "technical_ability": "LOW",
            "product_familiarity": "NEW",
            "patience": "LOW",
            "reading_style": "SCANNING",
            "device_class": "DESKTOP",
            "goal_context": "Trying the product for the first time",
        },
        "objective": "Create a project and invite a teammate.",
        "target_url": "https://staging.example.test",
        "allowed_origins": ["staging.example.test"],
        "max_actions": 40,
        "max_session_seconds": 180,
    }


class WorkerContractTests(unittest.TestCase):
    def test_accepts_authorized_https_plan(self):
        validated = validate_plan(plan())
        self.assertEqual(validated.allowed_origins, ("staging.example.test",))

    def test_rejects_non_https_target(self):
        raw = plan()
        raw["target_url"] = "http://staging.example.test"
        with self.assertRaises(PlanError):
            validate_plan(raw)

    def test_rejects_target_outside_allowlist(self):
        raw = plan()
        raw["target_url"] = "https://other.example.test"
        with self.assertRaises(PlanError):
            validate_plan(raw)

    def test_rejects_credentials_in_url(self):
        raw = plan()
        raw["target_url"] = "https://user:pass@staging.example.test"
        with self.assertRaises(PlanError):
            validate_plan(raw)

    def test_prompt_conditions_behavior_without_scripted_click_path(self):
        prompt = build_prompt(validate_plan(plan()))
        self.assertIn("not a QA engineer", prompt)
        self.assertIn("Create a project and invite a teammate.", prompt)
        self.assertIn("LOW", prompt)
        self.assertIn("Stay only on these authorized hosts", prompt)
        self.assertNotIn("click the", prompt.lower())


if __name__ == "__main__":
    unittest.main()
