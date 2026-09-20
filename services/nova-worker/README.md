# Centopus Nova worker

lambda_handler.py:handler is the agent-account Lambda entry point. worker.py validates the plan and owns the AgentCore lifecycle. evidence.py adapts foundation's custom Nova actuator to main's RawNovaStep[] response.

Use Python 3.12 and requirements.txt on Linux, matching the container runtime. Direct SDKs and their resolved transitive versions are pinned. Windows ARM may lack native dependency wheels; use Linux for full SDK/dependency checks. The Lambda image targets x86_64; the local Linux SDK check on ARM is not a container-build test.

From this directory:

```bash
python -m pip install -r requirements.txt
python -m pip check
python verify_sdk.py
python -m unittest discover -s . -p 'test_*.py'
python worker.py --plan-file plan.example.json --validate-only
```

`requirements.in` lists the intentional SDK pins. Regenerate `requirements.txt`
from the repository root on Linux/Python 3.12 with `pip-tools==7.6.1`:

```bash
python -m piptools compile --no-emit-index-url --no-emit-trusted-host --output-file services/nova-worker/requirements.txt services/nova-worker/requirements.in
```

After installing the lock, run `python -m pip check`, the SDK/test commands above,
and `python -m pip_audit --local` (CI pins pip-audit 2.10.1). The audit covers the
entire installed environment and fails on known vulnerabilities. Package versions
are locked; the upstream Lambda base-image tag is not digest-pinned, so deployment
must still build and validate the actual image.

Contract tests and plan validation do not need AWS credentials. Real execution requires an authorized HTTPS target, IAM credentials, AgentCore access and a Nova workflow. Do not repeatedly retry unavailable authentication.

The recorder captures executed browser methods, timing, observations and failures. It does not publish typed values or final model responses as evidence. Only a configured DOM checkpoint proves completion; absent instrumentation means completion stays unverified. Partial action traces can survive runtime failures. Cloud screenshots and Live View URLs are not produced.

The managed browser identifier defaults to aws.browser.v1. CDK supplies the workflow name. Root .env.example documents runtime settings. Direct CLI execution uses the same Python executor but does not reserve a control-plane budget; use the production API for aggregate admission reservations.
