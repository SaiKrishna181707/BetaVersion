# Synthetic Beta

> Before you recruit your first 100 beta users, deploy 100 synthetic users and watch where your product breaks.

Synthetic Beta points autonomous browser agents at a **web product you are authorized to test**, gives them
one objective, and records what actually happened. Every finding is tied to a recorded action in a specific
session. Numerical metrics are computed deterministically from event data, never written by a language model.

Synthetic users are simulated agents. They are **not** real beta users, do not represent real market demand,
and do not replace research with real people. They are an earlier, cheaper signal.

---

## Status: foundation plus the L1 browser session

This repository contains the foundation and the first end-to-end milestone: **one synthetic user** that
operates the demo product in a real local browser, decides its own actions from what is visible on screen,
and writes a structured, inspectable event log. AWS execution is still deliberately absent, and nothing in
this repository pretends otherwise.

**Built and verified**

- Monorepo skeleton with npm workspaces (`apps`, `packages`, `services`).
- `packages/contracts` — the single source of truth for every shared type, guardrail, and validation rule.
- `packages/ui` — design system: icons, brand, buttons, badges, fields, and the base stylesheet.
- `services/population` — deterministic synthetic cohort sampling (seeded, reproducible, no model).
- `services/analytics` — deterministic metrics from recorded sessions and events.
- `services/report` — evidence-grounded report assembly from metrics plus citations.
- `services/agent-worker` — guardrail review, the executor port, a persona-aware local policy, and
  the deterministic session loop (timers, action budget, remaining-budget guard, duplicate-state detection,
  origin allowlist, cancellation, checkpoint capture, and outcome classification). A session that repeats
  one screen for `MAX_RETRIES_SAME_STATE` actions ends as `ABANDONED`, not as a timeout.
- `local-playwright` — a **local** executor that drives an installed Chrome or Edge against an
  authorized target and writes `session.json`, `events.json`, and screenshots to `.artifacts/`.
- `services/api` — transport skeleton for API Gateway/Lambda doing deterministic work only.
- Landing page and New Run page, with an honest routing foundation and a real not-found surface.
- 99 tests covering contracts, cost arithmetic, sampling, analytics, guardrails, reports, routing, the API,
  the agent policy, the session loop, and session artefact redaction.
- `demo-target/` — an authorized local demo product with deliberate friction, used as the test target.

**Deliberately not built yet**

- AWS execution. No Nova Act, AgentCore Browser, Step Functions, DynamoDB, or S3 calls exist in this repo.
  `createUnconfiguredSessionExecutor()` reports itself unavailable and throws rather than emitting
  plausible-looking synthetic events; the local Playwright executor is a development adapter behind the same
  `SessionExecutorPort`.
- The Population Preview, Live Run, Session Detail, Run Report, and Cost/Settings screens. They are registered
  in the route table as `PLANNED` and render an honest placeholder instead of a fake dashboard.
- `infra/cdk` and `infra/policies`. See `infra/README.md` for the intended topology and the reason these are
  documentation-only until the AWS surface can be verified against real documentation.

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
infra/               Intended AWS topology (documentation only, for now)
docs/                architecture, cost model, demo script
```

## Getting started

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev        # front end on http://127.0.0.1:5173
npm run dev:demo   # demo target on http://127.0.0.1:4174
npm run l1:run     # one synthetic user, one real browser session (needs the demo target)
npm test           # 99 unit and integration tests
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
the rule that a secret never goes in a `VITE_` variable. No AWS entry is read by any code in this repository
yet, because the execution plane is not built. The only variable the front end reads today is
`VITE_AUTHORIZED_DOMAINS`, which sits beside the front end in `apps/web/.env.example`.

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
