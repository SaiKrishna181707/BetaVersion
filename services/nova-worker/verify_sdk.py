"""Offline compatibility check for the pinned production browser SDK surface."""
import inspect
from bedrock_agentcore.tools.browser_client import BrowserClient
from nova_act import GuardrailDecision, NovaAct, Workflow
from nova_act.tools.browser.default.default_nova_local_browser_actuator import DefaultNovaLocalBrowserActuator

for cls, required in [
    (BrowserClient.start, ['identifier', 'session_timeout_seconds']),
    (NovaAct, ['cdp_endpoint_url', 'cdp_headers', 'cdp_use_existing_page', 'actuator', 'starting_page', 'workflow', 'state_guardrail', 'headless', 'tty', 'logs_directory', 'go_to_url_timeout']),
    (NovaAct.act, ['max_steps', 'timeout']),
    (Workflow, ['workflow_definition_name', 'model_id', 'boto_session_kwargs']),
]:
    signature = inspect.signature(cls)
    for parameter in required:
        if parameter not in signature.parameters:
            raise SystemExit(f'{cls.__name__} lacks {parameter}')
for method in ['start', 'get_page', 'go_to_url', 'agent_click', 'agent_type', 'agent_scroll', 'agent_hover', 'wait']:
    if not callable(getattr(DefaultNovaLocalBrowserActuator, method, None)):
        raise SystemExit(f'Actuator lacks {method}')
assert all(callable(getattr(BrowserClient, name, None)) for name in ['generate_ws_headers', 'stop'])
assert GuardrailDecision.PASS is not None and GuardrailDecision.BLOCK is not None
print('Pinned AgentCore/Nova actuator SDK surface verified; no AWS call performed.')
