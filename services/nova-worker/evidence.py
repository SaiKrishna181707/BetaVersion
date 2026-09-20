"""Observed browser actions in main's RawNovaStep shape.

Adapted from foundation's custom Nova actuator. No LLM response or HTML log is
interpreted as an action, timestamp, screenshot, or successful objective.
"""
import functools
import hashlib
import inspect
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit


class SessionStop(Exception):
    pass


def safe_url(value):
    url = urlsplit(value)
    return urlunsplit((url.scheme, url.netloc.split('@')[-1], url.path, '', ''))


class BrowserEvidence:
    def __init__(self, plan):
        self.plan = plan
        self.started = time.monotonic()
        self.deadline = self.started + plan.max_session_seconds
        self.steps = []
        self.page = None
        self.reason = None
        self.reached = set()
        self.previous = None
        self.repeats = 0
        self.actions = 0
        self.console_errors = []
        self.network_errors = []

    def authorized(self, value):
        url = urlsplit(value)
        host = (url.hostname or '').rstrip('.').encode('idna').decode('ascii').lower()
        return url.scheme == 'https' and not url.username and not url.password and host in self.plan.allowed_origins

    def stop(self, reason):
        self.reason = reason
        raise SessionStop(reason)

    def check(self):
        if self.reason:
            raise SessionStop(self.reason)
        if time.monotonic() >= self.deadline:
            self.stop('TIMED_OUT')
        if self.actions >= self.plan.max_actions:
            self.stop('ACTION_LIMIT')

    def attach(self, page):
        self.page = page
        page.set_default_timeout(5000)
        page.set_default_navigation_timeout(10000)
        # Do not persist page-controlled messages, typed text, model programs, or secrets.
        page.on('pageerror', lambda _: self.console_errors.append('Browser page error observed'))
        page.on('console', lambda msg: self.console_errors.append('Browser console error observed') if msg.type == 'error' else None)
        page.on('requestfailed', lambda _: self.network_errors.append('Browser request failed'))
        page.on('response', lambda response: self.network_errors.append(f'HTTP {response.status}') if response.status >= 400 else None)

        def route(request_route):
            if self.authorized(request_route.request.url):
                request_route.continue_()
            else:
                self.network_errors.append('Blocked request outside authorized hosts')
                request_route.abort('blockedbyclient')

        page.context.route('**/*', route)
        page.route('**/*', route)
        page.context.on('page', lambda popup: popup.close())

    def observe(self):
        if self.page is None or self.page.url == 'about:blank':
            return None
        if not self.authorized(self.page.url):
            self.stop('SAFETY_STOP')
        observed = self.page.evaluate('''() => ({
          url: location.href, title: document.title,
          text: document.body?.innerText ?? '',
          checkpoints: [...document.querySelectorAll('[data-synthetic-checkpoint]')]
            .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
            .map(e => e.getAttribute('data-synthetic-checkpoint'))
        })''')
        self.reached.update(cp for cp in observed['checkpoints'] if cp in self.plan.checkpoint_plan)
        return {
            'url': safe_url(observed['url']), 'title': observed['title'][:200],
            'checkpoints': sorted(self.reached),
            # Hash stays internal, so browser text and input values never leave the worker.
            '_state': hashlib.sha256((observed['url'] + observed['text']).encode()).hexdigest(),
        }

    def action(self, method, call, args, kwargs):
        before = self.observe()
        self.check()
        bound = inspect.signature(call).bind(*args, **kwargs).arguments
        if method == 'go_to_url' and not self.authorized(bound['url']):
            self.stop('SAFETY_STOP')
        if method == 'wait':
            bound['seconds'] = min(float(bound['seconds']), 2, max(0, self.deadline - time.monotonic()))
        state = before and before['_state']
        self.repeats = self.repeats + 1 if state and state == self.previous else 0
        self.previous = state
        if self.repeats >= 5:
            self.stop('ABANDONED')
        self.actions += 1
        target = bound.get('box')
        descriptor = f'box:{target}' if target else None
        # Foundation's pre-action guard: do not enter credentials or activate destructive/payment controls.
        if target:
            import re
            numbers = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?', str(target))]
            if len(numbers) == 4:
                top, left, bottom, right = numbers
                control = self.page.evaluate('''([x,y]) => {
                  const e = document.elementFromPoint(x,y)?.closest('button,a,input,textarea,[role=button]');
                  return e ? {type:e.getAttribute('type'), label:e.innerText || e.getAttribute('aria-label') || ''} : {};
                }''', [(left + right) / 2, (top + bottom) / 2])
                sandbox_login = (bound.get('value') == 'sandbox'
                                 and 'Disposable sandbox account, not a secret:' in self.page.inner_text('body'))
                if (control.get('type') == 'password' and not sandbox_login) or re.search(
                    r'\b(buy|purchase|pay|delete|captcha)\b', control.get('label', ''), re.I
                ):
                    self.stop('SAFETY_STOP')
        error = None
        result = None
        try:
            result = call(**bound)
        except Exception as exc:
            error = exc
        after = None
        try:
            after = self.observe()
        except Exception as exc:
            error = error or exc
        observation = after or before
        action_type = {'agent_click': 'click', 'agent_type': 'type', 'agent_scroll': 'scroll',
                       'go_to_url': 'navigate', 'wait': 'wait'}.get(method)
        # Hover counts toward limits but is not mislabelled as a click in the contract.
        if action_type and observation:
            status = 'ERROR' if error else 'NO_CHANGE' if method == 'agent_click' and before and after and before['_state'] == after['_state'] else 'SUCCESS'
            observed_checkpoints = observation['checkpoints']
            final = self.plan.checkpoint_plan[-1] if self.plan.checkpoint_plan else None
            complete = final is not None and final in observed_checkpoints and not error
            self.steps.append({
                'sequence': len(self.steps) + 1,
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'elapsed_ms': int((time.monotonic() - self.started) * 1000),
                'action': {'type': action_type, 'target': descriptor},
                'observation': {k: v for k, v in observation.items() if not k.startswith('_')},
                'status': status,
                'agent_reason_code': 'OBJECTIVE_COMPLETE' if complete else 'RETRYING' if self.repeats else 'EXPLORING',
                'error': type(error).__name__ if error else None,
                'screenshot_ref': None,
            })
            self.steps[-1]['observation']['console_errors'] = self.console_errors[-10:]
            self.steps[-1]['observation']['network_errors'] = self.network_errors[-10:]
            self.console_errors.clear()
            self.network_errors.clear()
            if complete:
                self.reason = 'OBJECTIVE_COMPLETE'
        if error:
            raise error
        return result


def recorded_actuator(evidence):
    from nova_act.tools.browser.default.default_nova_local_browser_actuator import DefaultNovaLocalBrowserActuator

    class RecordedActuator(DefaultNovaLocalBrowserActuator):
        def start(self, **kwargs):
            super().start(**kwargs)
            evidence.attach(self.get_page())
            self.go_to_url(evidence.plan.target_url)

    def instrument(name):
        original = getattr(DefaultNovaLocalBrowserActuator, name)

        @functools.wraps(original)
        def recorded(self, *args, **kwargs):
            return evidence.action(name, functools.partial(original, self), args, kwargs)
        return recorded

    for name in ('agent_click', 'agent_type', 'agent_scroll', 'agent_hover', 'go_to_url', 'wait'):
        setattr(RecordedActuator, name, instrument(name))
    return RecordedActuator
