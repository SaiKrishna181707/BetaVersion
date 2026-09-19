# Synthetic Beta

> Before you recruit your first 100 beta users, deploy up to 100 synthetic users and watch where your product breaks.

Synthetic Beta is an autonomous pre-beta testing system for **web products you own or are authorized to test**.
Each synthetic user receives a structured persona and one objective, then operates the real product in a browser.
The platform records what happened, computes deterministic behavioral metrics, and builds evidence-linked findings.

Synthetic users are simulated agents. They are **not real beta users, do not measure market demand, and do not
replace validation with real people**. The product is an earlier, cheaper signal for obvious usability and flow
failures before a real beta cohort is spent.

## Why this is different

This is not a 100-persona survey.

The target architecture is:

```text
authorized product URL
        ↓
synthetic population
        ↓
objective per persona
        ↓
Nova Act
        ↓
AgentCore Browser
        ↓
real clicks / typing / navigation / retries / abandonment
        ↓
recorded evidence
        ↓
deterministic analytics
        ↓
evidence-grounded report
```

The LLM/agent decides how to use the product. Code computes the numbers.

## Current status

### Built and verified locally

- npm-workspace monorepo with React/TypeScript frontend and typed shared contracts.
- Local Playwright browser adapter that runs one synthetic persona against an owned demo product.
- Persona-aware decision policy for zero-cloud-cost loop/telemetry testing.
- Session guardrails: authorization, exact-host allowlists, action/time/retry/budget ceilings, cancellation, safe artifact identifiers and URL-secret redaction.
- Structured session artifacts: `session.json`, `events.json`, checkpoint/final screenshots.
- Deterministic population sampling.
- Deterministic completion, abandonment, timeout, technical-failure, funnel, friction and cohort metrics.
- Evidence-grounded report assembly with session/action pointers and fail-closed trace-integrity checks.
- Owned `demo-target/` with deliberate UX friction.
- 124 Node unit/integration/stress tests, including cost monotonicity, hostile URL, traversal, data-integrity and population invariants.

### Real AWS execution adapter implemented

`services/nova-worker/` is the L2 worker for one genuine autonomous AWS session:

- Nova Act workflow mode with AWS IAM authentication,
- Amazon Bedrock AgentCore Browser over CDP,
- persona + objective behavior prompt,
- exact-host Nova Act state guardrails plus a server-side AgentCore Browser session timeout,
- public-target-only cloud execution with private/link-local/local host rejection,
- strict persona/input contracts and bounded observation budgets,
- no Nova Act API key required by the worker,
- Python contract/adversarial tests that run in CI without AWS credentials.

The AWS worker is intentionally honest about its current boundary: it proves the real autonomous browser path,
but Nova/AgentCore trace steps are **not yet** converted into the TypeScript `BehaviorEvent[]` schema. The code
will not manufacture events from a final model response.

### Still required before final hackathon submission

- Execute and record one real Nova Act + AgentCore Browser run in the hackathon AWS account.
- Connect actual AWS trace evidence into the shared event model.
- Scale 1 → 5 → 20 → 100 synthetic sessions.
- Finish the Live Run, Session Detail and Run Report surfaces using real run data.
- Connect the frontend to AWS services and deploy `main` through Amplify Hosting.
- Capture the final 100-user run used in the three-minute demo.

Track the release gate in [docs/submission-checklist.md](docs/submission-checklist.md).

## Repository layout

```text
apps/web/              React + TypeScript + Vite frontend
packages/contracts/    Shared types, validation, guardrails, cost model
packages/ui/           UI primitives and stylesheet
services/api/          API-shaped deterministic control-plane functions
services/population/   Seeded synthetic population
services/agent-worker/ Local browser loop, telemetry and guardrails
services/nova-worker/  Real Nova Act + AgentCore Browser AWS worker
services/analytics/    Deterministic behavioral metrics
services/report/       Evidence-grounded findings/report
demo-target/           Owned local product with deliberate friction
tests/                 Node unit/integration tests
infra/                 Target AWS topology and IAM boundaries
docs/                  Architecture, costs, AWS execution and demo guidance
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
| Global internal spend ceiling | $80 |
| Default per-run hard cap | $45 |
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
