# Synthetic Beta

> Before you recruit your first 100 beta users, deploy 100 synthetic users and watch where your product breaks.

Synthetic Beta points autonomous browser agents at a **web product you are authorized to test**, gives them
one objective, and records what actually happened. Every finding is tied to a recorded action in a specific
session. Numerical metrics are computed deterministically from event data, never written by a language model.

Synthetic users are simulated agents. They are **not** real beta users, do not represent real market demand,
and do not replace research with real people. They are an earlier, cheaper signal.

---

## Execution status

Local L1 and independent multi-session runs are operational. The existing UI creates runs,
shows session progress and deterministic metrics, and opens screenshots, replay archives and reports.

The AWS path uses API Gateway/Lambda, Step Functions, the Nova Act Python SDK, isolated AgentCore
Browser sessions, DynamoDB and S3. The existing CDK stacks synthesize and the session container builds.
Nova Act actuator calls are recorded as browser facts, then passed through the shared trace adapter.
Completion requires the demo's observed final checkpoint; model return text cannot declare success.

**A real AWS run has not been verified:** the current AWS CLI session reports `NoCredentials`.
Local CDP and SDK actuator tests do not constitute AWS execution.

Run `aws login` interactively to establish the AWS session, then `npm run aws:deploy` to deploy the
existing stacks, publish the console to Amplify, and execute the five-session AWS smoke test against
the deployed demo. The script stops on any deployment or verification failure. AWS account and region
come from the CLI configuration, and deployed identifiers come from stack outputs.

- `npm run test:python`: Nova actuator evidence/guardrail tests.
- `npm run test:browser`: real UI flow (start `dev`, `dev:api`, and `dev:demo` first).
- `npm run test:nova-actuator`: installed SDK actuator against local CDP, without a model/AWS call.
  Build its image with `docker build --platform linux/arm64 --provenance=false -f services/agent-worker/Dockerfile -t betaversion-session:verification .`.
- `npm run test --prefix infra/cdk` and `npm run synth --prefix infra/cdk`: infrastructure checks.
- `npm run aws:smoke`: real AWS-only verification using `BETAVERSION_API_URL` and `BETAVERSION_DEMO_URL`.

AWS spend admission uses atomic cumulative DynamoDB reservations, including the retry allowance.
Reservations remain charged to the $250 execution allowance after interrupted runs. Displayed AWS
costs use the dated handoff rates and measured duration; they are estimates, not invoice amounts.

---

## Repository layout

```
apps/web/            React + TypeScript + Vite front end
packages/contracts/  Shared domain types, guardrails, validation, cost model
packages/ui/         Design system and stylesheet
services/api/        API Gateway/Lambda request handling
services/population/ Deterministic synthetic cohort sampling
services/agent-worker/ Session guardrail review and the browser executor port
services/analytics/  Deterministic metrics computed from recorded events
services/report/     Evidence-grounded report assembly
demo-target/         Authorized local demo product with deliberate friction
tests/               unit, integration, fixtures
infra/               Existing AWS CDK stacks and deployment configuration
docs/                architecture, cost model, demo script
```

## Getting started

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev        # front end on http://127.0.0.1:5173
npm run dev:demo   # demo target on http://127.0.0.1:4174
npm run l1:run     # one synthetic user, one real browser session (needs the demo target)
npm test           # unit and integration tests
npm run typecheck  # tsc --noEmit across apps, packages, services, and tests
npm run lint       # ESLint across apps, packages, services, and tests
npm run build      # typecheck, then a production Vite build
npm run check      # lint, tests, then build
```

`npm run dev:demo` serves the authorized demo target on port 4174, which is the URL the New Run form
suggests. See `demo-target/README.md` for the intentional friction it contains and how to use it in a demo.

`npm run l1:run` is the L1 milestone: one seeded persona, one objective, one real browser session against the
demo target. It needs an installed Chrome or Edge and a running demo target, and it writes its evidence to
`.artifacts/runs/<run_id>/sessions/<session_id>/` (git-ignored). It is a local development adapter, not AWS
execution. See `docs/l1-local-session.md`.

## Configuration

`.env.example` records the configuration surface: variable names, the handoff default where one exists, and
the rule that a secret never goes in a `VITE_` variable. The deployed Lambda configuration is supplied by CDK. The frontend reads
`VITE_AUTHORIZED_DOMAINS` and `VITE_API_BASE_URL`; neither may contain a secret.

## Guardrails

All limits live in `GUARDRAILS` in `packages/contracts/src/model.ts` and are enforced by shared validation.

| Limit | Value |
| --- | --- |
| `GLOBAL_SPEND_CEILING_USD` | 250 |
| `DEFAULT_RUN_HARD_CAP_USD` | 45 |
| `DEFAULT_SESSION_SECONDS` | 180 |
| `MAX_SESSION_SECONDS` | 300 |
| `DEFAULT_BATCH_SIZE` | 10 |
| `MAX_BATCH_SIZE` | 20 |
| `MAX_ACTIONS` | 40 |
| `MAX_RETRIES_SAME_STATE` | 5 |
| `MAX_USERS` | 100 |

`GLOBAL_SPEND_CEILING_USD` is cumulative across runs. With the handoff rates, even a maximum-size single run
costs about $49.56, so the per-run cap is the binding constraint. See `docs/cost-model.md`.

## Safety boundaries

Authorized targets only. Owned demo or staging environments are preferred. No real-money transactions, no
destructive actions, no spam, no credential stuffing, no CAPTCHA bypass, no access-control bypass, and no
arbitrary third-party testing. Use disposable test accounts where authentication is required. Never put
secrets in a prompt, a log, or a target URL. The New Run form rejects credential-bearing URLs and requires an
explicit authorization acknowledgement, and `services/agent-worker` re-checks every guardrail before a
session could start.

## Documentation

- `docs/architecture.md` — components, data flow, and the executor boundary.
- `docs/l1-local-session.md` — what the L1 browser session runs, what it writes, and what it does not claim.
- `docs/cost-model.md` — the arithmetic behind every estimate, with a worked example.
- `docs/demo-script.md` — the intended judge walkthrough.
- `infra/README.md` — intended AWS topology and IAM boundaries.
