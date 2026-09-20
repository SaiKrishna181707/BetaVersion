"""Observed browser actions in main's RawNovaStep shape.

The recorder is the evidence boundary: only browser-observed actions and states are
returned. Nova's prose is never treated as proof of success.
"""
import functools
import hashlib
import inspect
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit


class SessionStop(Exception):
    pass


def safe_url(value):
    url = urlsplit(value)
    return urlunsplit((url.scheme, url.netloc.split('@')[-1], url.path, '', ''))


_READ_ONLY_OBJECTIVE = re.compile(
    r"\b(find|locate|explore|understand|learn|review|compare|inspect|view|read|discover|identify|browse)\b",
    re.I,
)
_STATE_CHANGING_OBJECTIVE = re.compile(
    r"\b(create|register|sign\s*up|invite|add|submit|send|upload|checkout|buy|purchase|pay|order|delete|remove|book|reserve)\b",
    re.I,
)
_OBJECTIVE_STOP_WORDS = {
    "about", "after", "before", "company", "details", "from", "homepage", "information",
    "into", "latest", "more", "product", "products", "service", "services", "their", "there",
    "this", "through", "using", "website", "what", "where", "which", "with", "your",
}


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
        self.meaningful_actions = 0
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
        page.on(
            'console',
            lambda msg: self.console_errors.append('Browser console error observed')
            if msg.type == 'error' else None,
        )
        page.on('requestfailed', lambda _: self.network_errors.append('Browser request failed'))
        page.on(
            'response',
            lambda response: self.network_errors.append(f'HTTP {response.status}')
            if response.status >= 400 else None,
        )

        def route(request_route):
            request = request_route.request
            if self.authorized(request.url):
                request_route.continue_()
                return

            # A modern first-party page commonly loads fonts, scripts, images and APIs
            # from CDNs or service subdomains. Blocking those requests makes the page
            # unusable and caused false technical failures. Only cross-origin browser
            # navigations are blocked here; the Nova state guardrail independently
            # prevents the top-level browser from leaving the authorized host.
            try:
                is_navigation = request.is_navigation_request()
            except Exception:
                is_navigation = False

            if is_navigation:
                self.network_errors.append('Blocked navigation outside authorized hosts')
                request_route.abort('blockedbyclient')
            else:
                request_route.continue_()

        # One context-level route is enough; registering a second page route can cause
        # the same request to be handled twice.
        page.context.route('**/*', route)
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
        text = observed['text'][:20000]
        return {
            'url': safe_url(observed['url']),
            'title': observed['title'][:200],
            'checkpoints': sorted(self.reached),
            # Internal-only values are removed before persistence.
            '_text': text,
            '_state': hashlib.sha256((observed['url'] + text).encode()).hexdigest(),
        }

    def objective_matches(self, observation):
        """Return browser-visible tokens supporting a read-only objective.

        This is deliberately conservative. State-changing objectives still require
        explicit DOM checkpoints. For read-only research/browse objectives, at least
        two meaningful browser actions plus visible objective vocabulary can prove
        completion without trusting Nova's final prose.
        """
        if self.plan.checkpoint_plan:
            return []
        objective = self.plan.objective.strip().lower()
        if not _READ_ONLY_OBJECTIVE.search(objective) or _STATE_CHANGING_OBJECTIVE.search(objective):
            return []
        if self.meaningful_actions < 2:
            return []

        words = {
            token for token in re.findall(r"[a-z0-9][a-z0-9+-]{2,}", objective)
            if token not in _OBJECTIVE_STOP_WORDS and not _READ_ONLY_OBJECTIVE.fullmatch(token)
        }
        if not words:
            return []

        visible = " ".join([
            observation.get('_text', ''),
            observation.get('title', ''),
            observation.get('url', ''),
        ]).lower()
        matches = sorted(word for word in words if word in visible)
        return matches if matches else []

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
        descriptor = None
        control = {}
        if target:
            numbers = [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?', str(target))]
            if len(numbers) == 4:
                top, left, bottom, right = numbers
                control = self.page.evaluate('''([x,y]) => {
                  const e = document.elementFromPoint(x,y)?.closest('button,a,input,textarea,select,[role=button],[role=link]');
                  if (!e) return {};
                  const label = e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '';
                  return {type:e.getAttribute('type'), role:e.getAttribute('role') || e.tagName.toLowerCase(), label};
                }''', [(left + right) / 2, (top + bottom) / 2])
                raw_label = re.sub(r'\s+', ' ', str(control.get('label', ''))).strip()
                if raw_label:
                    descriptor = raw_label[:160]
                elif control.get('role'):
                    descriptor = f"{control.get('role')} control"

                # Foundation's pre-action guard: do not enter credentials or activate
                # destructive/payment controls.
                sandbox_login = (
                    bound.get('value') == 'sandbox'
                    and 'Disposable sandbox account, not a secret:' in self.page.inner_text('body')
                )
                if (
                    (control.get('type') == 'password' and not sandbox_login)
                    or re.search(r'\b(buy|purchase|pay|delete|captcha)\b', str(control.get('label', '')), re.I)
                ):
                    self.stop('SAFETY_STOP')

        if descriptor is None and method == 'agent_scroll':
            descriptor = 'Page content'
        elif descriptor is None and method == 'wait':
            descriptor = 'Current page'

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
        action_type = {
            'agent_click': 'click',
            'agent_type': 'type',
            'agent_scroll': 'scroll',
            'go_to_url': 'navigate',
            'wait': 'wait',
        }.get(method)

        if action_type and observation:
            status = (
                'ERROR' if error
                else 'NO_CHANGE'
                if method == 'agent_click' and before and after and before['_state'] == after['_state']
                else 'SUCCESS'
            )
            if not error and action_type in {'click', 'scroll', 'navigate', 'type'}:
                self.meaningful_actions += 1

            observed_checkpoints = observation['checkpoints']
            final = self.plan.checkpoint_plan[-1] if self.plan.checkpoint_plan else None
            checkpoint_complete = final is not None and final in observed_checkpoints and not error
            objective_matches = [] if error else self.objective_matches(observation)
            read_only_complete = bool(objective_matches)
            complete = checkpoint_complete or read_only_complete

            persisted_observation = {
                key: value for key, value in observation.items() if not key.startswith('_')
            }
            if objective_matches:
                persisted_observation['objective_matches'] = objective_matches[:8]

            self.steps.append({
                'sequence': len(self.steps) + 1,
                'timestamp': datetime.now(timezone.utc).isoformat(),
                'elapsed_ms': int((time.monotonic() - self.started) * 1000),
                'action': {'type': action_type, 'target': descriptor},
                'observation': persisted_observation,
                'status': status,
                'agent_reason_code': (
                    'OBJECTIVE_COMPLETE' if complete
                    else 'RETRYING' if self.repeats
                    else 'EXPLORING'
                ),
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
