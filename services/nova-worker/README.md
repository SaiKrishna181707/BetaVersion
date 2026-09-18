# Nova Act + AgentCore Browser worker

This directory is the **real AWS execution milestone** for Synthetic Beta. It is separate from the local
Playwright adapter so the project can test deterministic analytics locally without cloud spend while still
having a production-shaped AWS browser path.

## What it does

One JSON session plan is validated before any cloud call. The worker then:

1. authenticates through AWS IAM using a Nova Act workflow,
2. opens an isolated Amazon Bedrock AgentCore Browser session,
3. connects Nova Act to the managed browser over CDP,
4. gives the agent the persona, objective and safety boundaries,
5. lets Nova Act decide how to use the product,
6. prints an explicit JSON result or an explicit failure.

No API key is used by this worker.

## Prerequisites

- Python 3.10+
- AWS credentials available to the process
- Nova Act access in the AWS account
- AgentCore Browser permissions
- a Nova Act workflow definition the caller is permitted to use
- an **authorized public HTTPS staging/demo target**

Nova Act currently documents US East (N. Virginia) as its supported region, so this worker defaults to
`us-east-1`. Override `AWS_REGION` only when the service documentation for your account supports it.

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r services/nova-worker/requirements.txt
```

## Validate locally without AWS spend

Edit a copy of `plan.example.json`, then:

```bash
python services/nova-worker/worker.py \
  --plan-file services/nova-worker/plan.example.json \
  --validate-only
```

Validation rejects non-HTTPS targets, credential-bearing URLs and hosts outside the explicit allowlist.

## Run one real AWS synthetic user

```bash
export AWS_REGION=us-east-1
export NOVA_ACT_WORKFLOW_NAME=synthetic-beta-browser-session
export NOVA_ACT_MODEL_ID=nova-act-latest

python services/nova-worker/worker.py \
  --plan-file /path/to/authorized-session-plan.json
```

While it runs, the AgentCore Browser console can show the active browser through Live View. For the hackathon
demo, show that live browser next to the Synthetic Beta run/session UI.

## Deliberate current boundary

This milestone proves the real autonomous browser execution path. It does **not** yet convert Nova Act trace
steps into the TypeScript `BehaviorEvent[]` schema. Until that telemetry adapter lands, the worker returns the
Nova Act result envelope and the AWS console is the source of truth for the browser trace. The local L1 path
continues to prove the deterministic event/analytics pipeline.

Do not fabricate TypeScript events from the final Nova response. The next adapter must derive them from actual
Nova/AgentCore trace data.
