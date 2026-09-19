"""Contract/guardrail tests. No AWS responses or model decisions are fabricated."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('nova_runner', ROOT / 'services/agent-worker/python/nova_runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'trace.jsonl'
        self.evidence = runner.BrowserEvidence({'journal': str(self.path), 'artifacts_dir': self.temp.name,
            'plan': {'max_session_seconds': 30, 'max_actions': 2, 'remaining_budget_cents': 20,
                     'checkpoint_plan': ['OPEN_APP', 'INVITE_TEAMMATE'], 'allowed_origins': ['demo.test']},
            'max_retries_same_state': 5, 'action_cost_cents': 1})

    def tearDown(self):
        if not self.evidence.file.closed:
            self.evidence.finish()
        self.temp.cleanup()

    def test_returning_without_browser_checkpoint_is_not_success(self):
        self.evidence.finish()
        self.assertEqual(json.loads(self.path.read_text().splitlines()[-1])['status'], 'ABANDONED')

    def test_actual_checkpoint_completes(self):
        self.evidence.reached.add('INVITE_TEAMMATE')
        self.evidence.finish()
        self.assertEqual(json.loads(self.path.read_text().splitlines()[-1])['status'], 'COMPLETED')

    def test_safety_stop_cannot_be_overridden_by_checkpoint(self):
        self.evidence.reached.add('INVITE_TEAMMATE')
        self.evidence.reason = 'SAFETY_STOP'
        self.evidence.finish()
        self.assertEqual(json.loads(self.path.read_text().splitlines()[-1])['status'], 'FAILED')

    def test_action_and_time_limits_stop_before_execution(self):
        self.evidence.seq = 2
        with self.assertRaises(runner.SessionStop):
            self.evidence.check()
        self.assertEqual(self.evidence.reason, 'ACTION_LIMIT')
        self.evidence.reason = None
        self.evidence.deadline = 0
        with self.assertRaises(runner.SessionStop):
            self.evidence.check()
        self.assertEqual(self.evidence.reason, 'TIMED_OUT')

    def test_same_state_stops_before_sixth_repeat(self):
        self.evidence.plan['max_actions'] = 40
        self.evidence.observe = lambda **kwargs: 'unchanged'
        calls = []
        def wait(seconds):
            calls.append(seconds)
        for _ in range(5):
            self.evidence.action('wait', wait, (0,), {})
        with self.assertRaises(runner.SessionStop):
            self.evidence.action('wait', wait, (0,), {})
        self.assertEqual(len(calls), 5)
        self.assertEqual(self.evidence.reason, 'ABANDONED')

    def test_error_and_attempt_are_real_and_correlated(self):
        self.evidence.observe = lambda **kwargs: 'unchanged'
        def click(box):
            raise RuntimeError('Element detached')
        with self.assertRaisesRegex(RuntimeError, 'Element detached'):
            self.evidence.action('agent_click', click, (None,), {})
        entries = [json.loads(line) for line in self.path.read_text().splitlines()]
        self.assertEqual([entry['kind'] for entry in entries], ['ACTION', 'ACTION_RESULT'])
        self.assertEqual(entries[0]['seq'], entries[1]['seq'])
        self.assertEqual(entries[1]['console_error'], 'Element detached')

    def test_sensitive_values_and_urls_are_redacted(self):
        self.assertNotIn('sensitive', runner.safe_text('password=sensitive token=sensitive'))
        self.assertEqual(runner.safe_url('https://user:secret@demo.test/path?token=sensitive'), 'https://demo.test/path')
        self.assertFalse(self.evidence.authorized('https://demo.test.evil.test/'))
        self.assertFalse(self.evidence.authorized('file:///tmp/file'))


if __name__ == '__main__':
    unittest.main()
