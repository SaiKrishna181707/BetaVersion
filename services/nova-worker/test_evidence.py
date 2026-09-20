import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
from evidence import BrowserEvidence, SessionStop
from worker import validate_plan, execute_with_aws
from test_worker import plan


class Page:
    url = 'https://staging.example.test/app'

    def __init__(self):
        self.checkpoints = []
        self.context = SimpleNamespace(route=lambda *args: None, on=lambda *args: None)

    def evaluate(self, script, args=None):
        return {} if args else {'url': self.url, 'title': 'Observed title', 'text': 'Observed page', 'checkpoints': self.checkpoints}

    def set_default_timeout(self, *args): pass
    def set_default_navigation_timeout(self, *args): pass
    def on(self, *args): pass
    def route(self, *args): pass


class EvidenceTests(unittest.TestCase):
    def recorder(self):
        evidence = BrowserEvidence(replace(validate_plan(plan()), checkpoint_plan=('goal',)))
        evidence.attach(Page())
        return evidence

    def test_records_only_executed_actions_with_measured_time_and_no_typed_value(self):
        evidence = self.recorder()
        evidence.action('agent_type', lambda value: None, (), {'value': 'private value'})
        step = evidence.steps[0]
        self.assertEqual(step['action']['type'], 'type')
        self.assertIsInstance(step['elapsed_ms'], int)
        self.assertIn('+00:00', step['timestamp'])
        self.assertNotIn('private value', str(step))
        self.assertIsNone(step['screenshot_ref'])

    def test_failed_action_retains_partial_evidence(self):
        evidence = self.recorder()
        def fail(): raise RuntimeError('sensitive failure details')
        with self.assertRaises(RuntimeError):
            evidence.action('agent_click', fail, (), {})
        self.assertEqual(evidence.steps[0]['status'], 'ERROR')
        self.assertNotIn('sensitive failure details', str(evidence.steps))

    def test_goal_requires_explicit_observed_checkpoint(self):
        evidence = self.recorder()
        evidence.action('agent_click', lambda: None, (), {})
        self.assertIsNone(evidence.reason)
        evidence.page.checkpoints = ['goal']
        evidence.action('agent_click', lambda: None, (), {})
        self.assertEqual(evidence.reason, 'OBJECTIVE_COMPLETE')

    def test_limits_and_unauthorized_navigation_stop_before_action(self):
        evidence = self.recorder()
        calls = []
        with self.assertRaises(SessionStop):
            evidence.action('go_to_url', lambda url: calls.append(url), (), {'url': 'https://elsewhere.example.test'})
        self.assertEqual(calls, [])
        self.assertEqual(evidence.steps, [])
        evidence = self.recorder()
        evidence.actions = evidence.plan.max_actions
        with self.assertRaises(SessionStop): evidence.check()
        self.assertEqual(evidence.reason, 'ACTION_LIMIT')

    def execute_fixture(self, *, checkpoint=False, cleanup_failure=False):
        class Browser:
            session_id = 'observed-session'
            def __init__(self, **kwargs): pass
            def start(self, **kwargs): pass
            def stop(self):
                if cleanup_failure: raise RuntimeError('cleanup failure')
            def generate_ws_headers(self): return 'wss://example.test', {}
        class Workflow:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
        class Actuator:
            def start(self, **kwargs): self.page = Page()
            def get_page(self): return self.page
            def go_to_url(self, url): self.page.url = url
            def agent_click(self): pass
            def agent_type(self, value): pass
            def agent_scroll(self): pass
            def agent_hover(self): pass
            def wait(self, seconds): pass
        class Nova(Workflow):
            def __init__(self, **kwargs): self.actuator = kwargs['actuator']()
            def __enter__(self): self.actuator.start(); return self
            def act(self, *args, **kwargs):
                if checkpoint: self.actuator.page.checkpoints = ['goal']
                self.actuator.agent_click()
                if checkpoint:
                    # The next action observes the deliberate stop; Nova wraps it.
                    try: self.actuator.agent_click()
                    except SessionStop as cause: raise RuntimeError('SDK wrapper') from cause
                return SimpleNamespace(response='Task completed successfully!')
        modules = {
            'bedrock_agentcore.tools.browser_client': SimpleNamespace(BrowserClient=Browser),
            'nova_act': SimpleNamespace(NovaAct=Nova, Workflow=Workflow, GuardrailDecision=SimpleNamespace(PASS=1, BLOCK=0)),
            'nova_act.tools.browser.default.default_nova_local_browser_actuator': SimpleNamespace(DefaultNovaLocalBrowserActuator=Actuator),
        }
        with patch.dict('sys.modules', modules):
            return execute_with_aws(replace(validate_plan(plan()), checkpoint_plan=('goal',)), region='test', workflow_name='test', model_id='test')

    def test_successful_model_response_does_not_prove_task_completion(self):
        result = self.execute_fixture()
        self.assertFalse(result['completed'])
        self.assertEqual(result['finish_reason'], 'ABANDONED')
        self.assertNotIn('response', result)
        self.assertGreater(len(result['steps']), 0)

    def test_sdk_wrapped_goal_stop_preserves_observed_completion(self):
        result = self.execute_fixture(checkpoint=True)
        self.assertTrue(result['completed'])
        self.assertEqual(result['finish_reason'], 'OBJECTIVE_COMPLETE')
        self.assertIsNone(result['execution_error'])

    def test_browser_cleanup_failure_is_reported_even_after_observed_goal(self):
        result = self.execute_fixture(checkpoint=True, cleanup_failure=True)
        self.assertFalse(result['completed'])
        self.assertEqual(result['finish_reason'], 'TECHNICAL_ERROR')
        self.assertEqual(result['cleanup_error'], 'RuntimeError')
        self.assertIn('goal', result['steps'][-1]['observation']['checkpoints'])


if __name__ == '__main__': unittest.main()
