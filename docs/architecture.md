# Architecture

Synthetic Beta deploys synthetic users into isolated browser sessions against a web product you are authorized
to test. The differentiator is that agents operate the **real product in a real browser**, while numerical
analytics remain deterministic functions of recorded evidence.

## Design principles

1. **Evidence before interpretation.** Models can decide actions and write labelled interpretation; they do not
   invent percentages.
2. **Honest surfaces.** Unbuilt or unconfigured execution paths fail explicitly instead of emitting plausible
   synthetic results.
3. **Boundaries before capability.** Authorization, origin, action, time and budget limits exist before scale.
4. **Replaceable execution.** Local Playwright validates the loop cheaply; Nova Act + AgentCore Browser is the
   real AWS execution path.
5. **Scale after one real session.** 1 → 5 → 20 → 100, keeping one session contract.

## Components

### Frontend — `apps/web`

React, TypeScript and Vite. The landing and New Run surfaces are built. Population Preview, Live Run, Session
Detail, Run Report and Settings are registered routes that remain honest placeholders until they have real data.

AWS Amplify Hosting is the submission hosting path; `amplify.yml` builds the npm-workspace monorepo from the
repository root and publishes `apps/web/dist`.

### Shared contracts — `packages/contracts`

The shared types define guardrails, personas, run configuration, browser observations, behavior events, metrics,
reports and the `SessionExecutorPort`. They keep analytics independent of whichever browser runtime produced
the evidence.

### Local browser execution — `services/agent-worker`

The L1 adapter uses an installed Chrome/Edge through Playwright. It proves:

- autonomous decision loop wiring,
- action/time/retry/budget limits,
- origin enforcement,
- structured observations,
- screenshot capture,
- event logging,
- deterministic outcome classification.

The current local policy is deliberately heuristic. It is a zero-cloud-cost test double for the agent judgment
boundary, not the final hackathon agent.

### AWS autonomous execution — `services/nova-worker`

The L2 worker is the real AWS path. It accepts one JSON session plan, validates it, then uses:

- Nova Act workflow mode with AWS IAM authentication,
- Amazon Bedrock AgentCore Browser,
- CDP between Nova Act and the managed browser,
- persona + objective conditioning rather than a scripted click path,
- explicit authorized-host and destructive-action boundaries.

The worker does **not** require `data-synthetic-checkpoint` hooks from the target product. Nova Act reasons over
the actual product UI and stops when the task is complete, blocked, abandoned or limited.

Current boundary: the worker returns an explicit Nova result envelope, while actual Nova/AgentCore trace steps
still need an adapter into `BehaviorEvent[]`. The system must never fabricate event rows from the final model
response.

### Population — `services/population`

`buildCohort` is seeded and reproducible. Traits are structured simulation inputs; any human-friendly persona
story shown later is presentation, not the source of analytics.

### Analytics — `services/analytics`

`computeRunMetrics` is a pure function over session records and behavior events. It produces completion,
abandonment, timeout, technical failure, time-to-value, retry/friction, funnel and cohort metrics. Rates retain
their numerator, denominator and supporting session IDs.

### Report — `services/report`

`buildSyntheticBetaReport` creates deterministic findings and attaches evidence pointers. Optional model
narration can interpret an existing finding but cannot change its metrics.

## Local evidence lifecycle

```text
SessionPlan
   ↓
local Playwright + policy
   ↓
BehaviorEvent[] + SessionRecord
   ↓
computeRunMetrics
   ↓
buildSyntheticBetaReport
```

## AWS execution lifecycle

```text
SessionPlan JSON
   ↓ validate
Nova Act workflow (IAM)
   ↓
AgentCore Browser
   ↓
real autonomous browser use
   ↓
Nova/AgentCore trace + result
   ↓
[trace adapter — next release gate]
   ↓
BehaviorEvent[] + SessionRecord
   ↓
existing deterministic analytics/report path
```

This separation is intentional: the browser/model runtime may change; the evidence/analytics contract should
not.

## Scale path

```text
L1  local 1-user pipeline proof
L2  1 real Nova Act + AgentCore Browser session
L3  5 real AWS sessions
L4  20-session controlled batch
L5  100 users, normally five batches of 20
```

The product promises up to 100 synthetic users; it does not require all 100 browsers to start simultaneously.

## Submission AWS topology

```text
GitHub main
   ↓
AWS Amplify Hosting ── frontend
   ↓
control plane (API/Lambda as connected)
   ↓
batch orchestration
   ↓
Nova Act workflow(s)
   ↓
AgentCore Browser sessions
   ↓
trace/evidence persistence
   ↓
deterministic analytics + report
```

The production topology can add Step Functions, DynamoDB and S3 as the batch/persistence layer. For the
hackathon, the non-negotiable proof is one genuine AWS agent session visible in AgentCore Live View, followed by
a controlled scale run.

## Security posture

- Authorized products only.
- AWS browser target must be public HTTPS.
- Target hostname must exist in the explicit allowlist.
- Credentials are forbidden in target URLs.
- No real-money purchases, destructive operations, spam, CAPTCHA bypass or access-control bypass.
- Typed secrets must not be persisted in evidence logs.
- Cost and session ceilings are enforced before scale.
