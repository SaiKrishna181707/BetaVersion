# Architecture

Synthetic Beta deploys synthetic users into isolated browser sessions against a web product you are authorized
to test. The differentiator is that the agents operate the **real product in a real browser**, and that every
number in the resulting report is computed from recorded events.

## Design principles

1. **Evidence before interpretation.** Metrics are deterministic functions of recorded events. A language model
   may cluster behaviour and write prose, but it may never produce a number.
2. **Honest surfaces.** Nothing in the UI claims to be live when it is not. A surface that is not built renders
   a stated placeholder; an executor that is not configured reports itself unavailable and throws.
3. **Boundaries before capability.** Guardrails are declared in one place, enforced by shared validation on the
   client, and re-checked server-side before a session could start.
4. **Ports, not stubs.** AWS integration is represented as typed ports and documented topology, never as
   invented SDK calls.

## Components

### Front end — `apps/web`

React, TypeScript, and Vite. Hash routing through a typed route table in `apps/web/src/router.ts`:

| Route | Surface | Status |
| --- | --- | --- |
| `#/` | Landing | Built |
| `#/new` | New run | Built |
| `#/runs/:runId/population` | Population preview | Planned |
| `#/runs/:runId/live` | Live run | Planned |
| `#/runs/:runId/sessions/:sessionId` | Session detail | Planned |
| `#/runs/:runId/report` | Run report | Planned |
| `#/settings` | Cost and settings | Planned |

A planned route resolves to an honest "registered, not built" surface rather than a mock dashboard. This keeps
navigation truthful while the execution phase lands.

### Shared contracts — `packages/contracts`

The single source of truth, so no type or rule is duplicated across services:

- `model.ts` — `GUARDRAILS`, session statuses, `BehaviorEvent`, `SyntheticPersona`, `RunConfiguration`,
  `SessionRecord`, `EvidenceRate`, `RunGateway`.
- `metrics.ts` — `SessionOutcome`, `FunnelStep`, `CohortMetrics`, `RunMetrics`.
- `population.ts` — `PopulationSpec` and the trait types derived from `SyntheticPersona`.
- `execution.ts` — `SessionPlan`, `SessionResult`, `RunPlan`, and `SessionExecutorPort`.
- `report.ts` — `EvidencePointer`, `ReportFinding`, `SyntheticBetaReport`, `ReportNarratorPort`.
- `validation.ts` / `cost.ts` — run configuration validation and the cost model.

### API — `services/api`

A transport-shaped handler (`createApiHandler`) that maps a request to a response and does deterministic work
only. It performs no I/O and calls no AWS service:

| Endpoint | Behaviour |
| --- | --- |
| `GET /health` | Reports `execution_available: false` and `mode: FOUNDATION` |
| `POST /runs/:id/estimate-cost` | Validates the configuration, returns the cost estimate |
| `POST /runs/:id/population-preview` | Builds and profiles a deterministic cohort |
| `POST /runs/:id/start` | `501 EXECUTION_NOT_CONFIGURED` |
| `GET /runs/:id/metrics` | `501 NO_RECORDED_EVENTS` |

An unknown route returns `404`, malformed JSON returns `400`, and a body over 16 KiB returns `413`.

### Agent worker — `services/agent-worker`

Owns the boundary between an approved plan and a browser. It exposes:

- `reviewSessionPlan(plan)` — returns every guardrail violation as a list of reasons.
- `assertSessionPlanWithinGuardrails(plan)` — throws `SessionPlanRejectedError` carrying those reasons.
- `SessionExecutorPort` — the interface a real runtime must implement.
- `createUnconfiguredSessionExecutor()` — the honest placeholder: `available: false`, and `execute()` rejects
  with `SessionExecutorUnavailableError` instead of fabricating behaviour.

The server-side review is the authoritative one; the form is a convenience. It re-checks action and duration
limits, remaining budget, the presence of a checkpoint plan and an origin allowlist, the transport scheme
(HTTPS, or HTTP only for a local sandbox), the absence of credentials in the URL, and membership of the target
host in the allowlist.

### Population — `services/population`

`buildCohort(spec)` turns a `PopulationSpec` into personas using an FNV-1a seed hash and a mulberry32
generator. The same spec always produces the same cohort, so a run stays reproducible and reviewable after the
fact. Trait assignment supports explicit weighted mixes and falls back to an equal share. `profileCohort`
summarises trait counts for the population preview surface.

### Analytics — `services/analytics`

`computeRunMetrics` is a pure function of `SessionRecord[]`, `BehaviorEvent[]`, `SyntheticPersona[]`, and the
ordered checkpoint plan. It produces completion, abandonment, timeout, and technical failure rates; median
time-to-value; retry and friction counts; a funnel; and per-cohort comparisons.

Every rate carries its numerator, denominator, and the session ids behind it. **An empty denominator reports
`null`, never `0%`.** A session counts as a technical failure when it ended `FAILED` or recorded a console
error, network error, or an action that returned `ERROR` — those are product defects, not user confusion.

### Report — `services/report`

`buildSyntheticBetaReport` assembles findings from the metrics and attaches `EvidencePointer`s that resolve to
specific actions in specific sessions. Four deterministic rules currently run: largest funnel drop-off,
technical failure, retry friction, and completion. Interpretation is strictly optional: without a
`ReportNarratorPort` every finding keeps `interpretation: null` and `interpretation_source: 'NONE'`. When a
narrator is supplied its text is labelled `NARRATOR` and the metrics are passed through untouched.

## Run lifecycle

```
RunConfiguration ──validate──▶ estimate ──▶ reviewed draft (local)
                                                │
                          (execution phase)     ▼
                     RunPlan ──▶ SessionPlan[] ──▶ reviewSessionPlan
                                                        │
                                                        ▼
                                          SessionExecutorPort.execute
                                                        │
                                            BehaviorEvent[] + SessionRecord
                                                        │
                            ┌───────────────────────────┴───────────────────────────┐
                            ▼                                                       ▼
                  computeRunMetrics                                    replay / screenshots
                            │
                            ▼
                buildSyntheticBetaReport ──▶ findings + evidence pointers
```

The behaviour model a session will eventually carry: persona, goal, constraints, browser session, observed UI
state, actions, navigation, retries, errors, screenshots and recordings, completion or abandonment, and timing.
An agent may make mistakes, retry, backtrack, get stuck, abandon, or hit a technical error. Those outcomes are
recording targets, not failures to hide.

## Intended AWS topology

Documented in `infra/README.md`. In short: CloudFront and S3 for the built front end, API Gateway and Lambda for
the control plane, Step Functions for batch orchestration, a browser-executor Lambda for agent sessions, DynamoDB
for run/session/event metadata, S3 for evidence artefacts, Bedrock (Nova) for interpretation only, and
CloudWatch for logs, metrics, and alarms. Each service gets its own least-privilege role; the spend ceiling is
enforced in the control plane before any batch is dispatched.

This phase ships the topology and the IAM boundaries as documentation, because guessing service action names
would be worse than deferring them.

## Metric guarantees

- Metrics derive only from recorded `SessionRecord` and `BehaviorEvent` rows.
- `computed_from` states how many rows each computation consumed, so a report can be audited.
- Rates expose their supporting session ids, so a percentage can always be traced back to sessions.
- Population sampling is seeded and reproducible.
- Cost estimation is pure, dated, and pinned by tests.

## Security posture

Least-privilege IAM is the target. Authorized domains come from explicit configuration, and
`VITE_AUTHORIZED_DOMAINS` is browser-visible by design and never carries a secret — production must verify
target ownership independently rather than trusting a client-side allowlist. Credentials are rejected in target
URLs. Disposable test accounts are referenced by `account_ref`, never by stored secrets. Session isolation is a
requirement of the executor: one browser context per synthetic user, no shared cookies or storage.