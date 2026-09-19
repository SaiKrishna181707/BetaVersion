"""Exercise the installed Nova Act actuator in a real CDP browser, without a model call.
This is an integration test, NOT an AWS or autonomous Nova Act smoke run.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile

from nova_act.tools.browser.default.playwright_instance_options import PlaywrightInstanceOptions

root = Path('/workspace')
spec = importlib.util.spec_from_file_location('runner', root / 'services/agent-worker/python/nova_runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
config = json.loads((root / '.cache/nova-verify/config.json').read_text())
evidence = runner.BrowserEvidence(config)
options = PlaywrightInstanceOptions(maybe_playwright=None, starting_page=config['plan']['target_url'],
    chrome_channel='chrome', headless=True, user_data_dir=tempfile.mkdtemp(), profile_directory=None,
    cdp_endpoint_url=os.environ['TEST_CDP_ENDPOINT'], cdp_headers={'Host': 'localhost'}, cdp_use_existing_page=True,
    # The local HTTP demo has no TLS endpoint. Production keeps certificate checks enabled.
    screen_width=1280, screen_height=800, user_agent=None, record_video=False, ignore_https_errors=True)
actuator = runner.recorded_actuator(evidence)(options)
try:
    actuator.start(session_logs_directory=tempfile.mkdtemp())
    page = actuator.get_page()
    assert page.url.startswith(config['plan']['target_url']), 'existing CDP page must open the target during startup'
    # Fresh state is a measured assertion, not a label assigned to reused state.
    assert page.evaluate('localStorage.length') == 0
    def box(hook):
        area = page.locator('[data-synthetic-target="' + hook + '"]').bounding_box()
        assert area is not None, hook
        return f'<box>{area["y"]},{area["x"]},{area["y"]+area["height"]},{area["x"]+area["width"]}</box>'
    actuator.agent_type('tester@sandbox.test', box('email'))
    actuator.agent_type('sandbox', box('password'))
    actuator.agent_click(box('sign-in-submit'))
    page.wait_for_timeout(200)
    actuator.agent_click(box('new-project'))
    actuator.agent_type('Actuator integration', box('project-name'))
    actuator.agent_click(box('create-project-submit'))
    page.wait_for_timeout(200)
    # Find the demo's actual overflow control from its DOM.
    hooks = page.locator('[data-synthetic-target]').evaluate_all('(es) => es.map(e => e.dataset.syntheticTarget)')
    menu = next(h for h in hooks if 'menu' in h or 'overflow' in h)
    actuator.agent_click(box(menu))
    hooks = page.locator('[data-synthetic-target]').evaluate_all('(es) => es.map(e => e.dataset.syntheticTarget)')
    invite = next(h for h in hooks if 'invite' in h)
    actuator.agent_click(box(invite))
    actuator.agent_type('qa@example.test', box('invite-email'))
    actuator.agent_click(box('invite-submit'))
    page.wait_for_timeout(1200)
    evidence.observe()
    assert 'INVITE_TEAMMATE' in evidence.reached
    evidence.finish()
    assert evidence.reason == 'OBJECTIVE_COMPLETE'
    print(json.dumps({'verified': 'real Nova SDK actuator, local CDP; no model or AWS call', 'actions': evidence.seq}))
finally:
    if not evidence.file.closed:
        evidence.finish()
    actuator.stop()
