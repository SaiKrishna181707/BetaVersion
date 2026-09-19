# Synthetic Beta

> Before you recruit your first 100 beta users, deploy up to 100 synthetic users and watch where your product breaks.

Synthetic Beta is an autonomous pre-beta testing system for **web products you own or are authorized to test**.
Each synthetic user receives a structured persona and one objective, then operates the real product in a browser.
The platform records what happened, computes deterministic behavioral metrics, and builds evidence-linked findings.

Synthetic users are simulated agents. They are **not real beta users, do not measure market demand, and do not
replace validation with real people**. The product is an earlier, cheaper signal for obvious usability and flow
failures before a real beta cohort is spent.

## Architecture: Dual-Account Isolation

Synthetic Beta runs on a canonical **dual-account architecture** that physically separates the client-facing control plane from the autonomous agent execution sandbox:

```text
CONTROL PLANE — Kittu Account (643700104680)
├── AWS Amplify Hosting (synthetic-beta-web)
│   ├── Production Dashboard: https://main.d1s2dm4wj8xxb.amplifyapp.com
│   ├── Demo Target 1 (Fieldwork SaaS): /demo-target/
│   └── Demo Target 2 (ShopPulse Checkout): /demo-target-checkout/
├── Amazon API Gateway (synthetic-beta-http-api: fkvvrndb17)
├── Amazon Cognito (synthetic-beta-users)
├── Amazon DynamoDB (SyntheticBetaState — single-table design)
├── AWS Step Functions (synthetic-beta-run-orchestrator — Distributed Map)
├── AWS Lambda (synthetic-beta-api, synthetic-beta-session-worker, synthetic-beta-finalizer)
├── Amazon S3 (synthetic-beta-artifacts-20260919-k7m4q2)
└── AWS Budgets & SNS ($80 Account Cap, $40 Run Cap, SNS Alerting)
       │
       │ STS AssumeRole: SyntheticBetaAgentExecutionRole
       ▼
AGENT EXECUTION PLANE — Vivek Account (768669378827)
├── Amazon Bedrock AgentCore Browser (SyntheticBetaBrowser / aws.browser.v1)
├── Real Browser Streams:
│   ├── WebSocket Automation Stream (CDP for Nova Act)
│   └── WebRTC Live View Stream (Real-time operator inspection)
├── Amazon Nova Act (workflow: synthetic-beta-browser-session, model: nova-act-v1.0)
└── Amazon S3 Trajectories & Export (synthetic-beta-artifacts-vivek-20260919)
```

The LLM/agent decides how to use the product in a real browser. Code computes the numbers from recorded evidence.

## Current status

### Verified Live AWS Infrastructure

- **AWS Amplify Hosting**: Deployed from `main` at [https://main.d1s2dm4wj8xxb.amplifyapp.com](https://main.d1s2dm4wj8xxb.amplifyapp.com) with active routes for New Run, Live Telemetry, Session Inspector, and Deterministic Reports.
- **Embedded Test Targets**: Deployed on Amplify for zero-external-dependency validation:
  - Demo Target 1: Fieldwork SaaS collaboration (`/demo-target/`) testing project creation and member invites.
  - Demo Target 2: ShopPulse e-commerce checkout (`/demo-target-checkout/`) testing cart operations, promo codes, and multi-step forms.
- **Amazon API Gateway & Lambda**: HTTP API `fkvvrndb17` handling run creation, status polling, session telemetry, metrics, and report downloads.
- **Amazon DynamoDB**: `SyntheticBetaState` storing single-table state for runs, sessions, events, metrics, and findings with automated 7-day TTL.
- **AWS Step Functions**: `synthetic-beta-run-orchestrator` executing parallel batches of synthetic users via Distributed Map.
- **AWS Budgets & SNS**: $80 account ceiling, $40 per-run hard cap with automated SNS notifications.

### Verified Real Autonomous Agent Execution

- **Bedrock AgentCore Browser**: Ephemeral headless Chromium micro-VMs (`SyntheticBetaBrowser` / `aws.browser.v1`) with server-side timeouts.
- **Automation & Live View Streams**: Direct CDP control over secure WebSockets plus real-time Live View video endpoints rendered in the web UI.
- **Amazon Nova Act**: Real multimodal browser reasoning (`synthetic-beta-browser-session`, `nova-act-v1.0`) driving DOM interaction without synthetic hooks.
- **Nova Trace Adapter**: Zero-hallucination adapter (`nova-trace-adapter.ts`) transforming raw Nova trajectories into strict `BehaviorEvent[]` records.
- **100-User Scale Verification**: Step Functions Distributed Map verified across 100 concurrent/batched synthetic users with deterministic funnel metrics.

### Local Simulation & Quality Gates

- Local Playwright browser adapter (`npm run l1:run`) for zero-cloud-cost policy and telemetry validation.
- 124 Node unit/integration/stress tests covering cost monotonicity, hostile URL rejections, path traversal, data integrity, and population determinism.
- Python SDK smoke tests and contract/adversarial tests passing in CI without cloud credentials.

## Repository layout

```text
apps/web/              React + TypeScript + Vite frontend (deployed to Amplify)
packages/contracts/    Shared types, validation, guardrails, cost model
packages/ui/           UI primitives and stylesheet
services/api/          API-shaped control-plane handlers & Lambda entry points
services/population/   Seeded synthetic population generator
services/agent-worker/ Local browser loop, Lambda session worker & Nova trace adapter
services/nova-worker/  Python Nova Act + AgentCore Browser execution adapter
services/analytics/    Deterministic behavioral metrics reducer
services/report/       Evidence-grounded findings and report finalizer Lambda
demo-target/           Owned local product with deliberate UX friction
tests/                 Node unit/integration/stress test suites
infra/                 CDK architecture, IAM trust policies, and dual-account topology
docs/                  Architecture, execution guides, cost model, demo script, reports
```

## Local development

Requires Node.js 22.12+.

```bash
npm install
npm run dev
npm run dev:demo
npm run l1:run
npm run check
```

- Workspace: `http://127.0.0.1:5173`
- Owned demo target: `http://127.0.0.1:4174`
- `npm run l1:run` runs one synthetic user in a real local Chrome/Edge session.

Local evidence is written under:

```text
.artifacts/runs/<run_id>/sessions/<session_id>/
  session.json
  events.json
  screenshots/
```

## Run the real AWS worker

Python 3.10+ is required.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r services/nova-worker/requirements.txt
```

Validate a session plan without AWS spend:

```bash
python services/nova-worker/worker.py \
  --plan-file services/nova-worker/plan.example.json \
  --validate-only
```

For a real run, use an **owned public HTTPS staging target**, configure AWS credentials and the Nova Act workflow,
then:

```bash
export AWS_REGION=us-east-1
export NOVA_ACT_WORKFLOW_NAME=synthetic-beta-browser-session
export NOVA_ACT_MODEL_ID=nova-act-latest

python services/nova-worker/worker.py --plan-file /path/to/session-plan.json
```

See [services/nova-worker/README.md](services/nova-worker/README.md) and
[docs/aws-execution.md](docs/aws-execution.md).

## Guardrails

| Limit | Value |
| --- | ---: |
| Global internal spend ceiling (AWS Budget) | $80 |
| Default per-run hard cap | $40 |
| Default session | 180 s |
| Maximum session | 300 s |
| Default batch | 10 |
| Maximum batch | 20 |
| Maximum actions/session | 40 |
| Maximum same-state retries | 5 |
| Maximum synthetic users/run | 100 |

Targets must be explicitly authorized. No real-money purchases, destructive actions, spam, credential stuffing,
CAPTCHA bypass, access-control bypass or arbitrary third-party testing.

## Evidence guarantees

- Metrics come from recorded session/event evidence, not model arithmetic.
- Rates keep numerator, denominator and supporting session IDs.
- Empty denominators report `null`, never a fake `0%`.
- Report findings link back to session/action evidence.
- Typed secrets are not persisted in event logs.
- Unconfigured execution paths fail explicitly instead of generating plausible fake results.

## CI and deployment

GitHub Actions runs:

- ESLint,
- Node unit/integration/stress tests,
- TypeScript typecheck,
- production Vite build,
- `npm audit --audit-level=high`,
- pinned Python dependency installation plus `pip check`,
- `pip-audit` against the Nova worker requirements,
- Python compile and Nova worker contract/adversarial tests,
- an installed-SDK smoke test for the AgentCore Browser and Nova Act call surface.

`amplify.yml` contains the AWS Amplify Hosting build specification for `apps/web`. Submission changes reach
`main` only through CI-green pull requests.

## Documentation

- [Architecture](docs/architecture.md)
- [Local L1 session](docs/l1-local-session.md)
- [AWS execution](docs/aws-execution.md)
- [Cost model](docs/cost-model.md)
- [Demo script](docs/demo-script.md)
- [Submission checklist](docs/submission-checklist.md)
- [Infrastructure topology](infra/README.md)

## License

MIT
