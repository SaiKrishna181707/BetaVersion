# L1: one synthetic user in a real browser

The first milestone from the handoff: **one synthetic user operates the demo application autonomously and
produces a saved structured event log.**

This is a local development adapter, not AWS execution. It does not use Nova Act or AgentCore Browser, it
writes nothing outside this machine, and it incurs no cloud cost.

## Run it

```bash
npm run dev:demo   # terminal 1: authorized demo target on http://127.0.0.1:4174
npm run l1:run     # terminal 2: one persona, one objective, one browser session
```

Requires Node 22.12 or newer and an installed Chromium-based browser (Chrome is tried first, then Edge).

| Variable | Default | Purpose |
| --- | --- | --- |
| `L1_TARGET_URL` | `http://localhost:4174` | target under test; its host must be in the plan's origin allowlist |
| `L1_SEED` | `l1-demo` | population seed; reproduces the persona, not browser timing or outcomes |
| `L1_HEADLESS` | `1` | set to `0` to watch the session in a visible window |
| `L1_SESSION_SECONDS` | `180` | session deadline handed to the loop |
| `L1_BROWSER_CHANNEL` | auto | pin one channel, for example `msedge` |
| `L1_SANDBOX_EMAIL` | `tester@sandbox.test` | disposable demo account, documented in `demo-target/README.md` |
| `L1_SANDBOX_PASSWORD` | `sandbox` | same; it is not a secret and grants nothing |

`npm run l1:run` exits `0` when the session reaches a decision the demo can use (`COMPLETED` or `ABANDONED`) and
`1` when the session timed out, failed, or was cancelled.

## What runs

Four pieces, each with a single responsibility:

- **Target** - `demo-target/`, an authorized local product with deliberate friction and no external requests.
- **Browser** - `PlaywrightPage` implements `BrowserPagePort`: it opens a URL, observes a page, performs one
  action, and captures a screenshot. It is the only part that knows a browser exists.
- **Judgment** - `createLocalAgentPolicy` implements `AgentPolicyPort`. It receives the observation, the
  persona, the objective, and the session history, and returns one action with a reason code. It never receives
  a click path, is seeded, and behaves differently per persona (technical ability, familiarity, patience,
  reading style). The production Nova worker uses a separate instrumented actuator.
- **Determinism** - `runSessionLoop` owns everything that must not be a judgment call: the session deadline,
  the action budget, the remaining-budget guard, duplicate-state detection, the origin allowlist, cancellation,
  checkpoint capture, and the mapping from stop reason to session status. Per the handoff, timers, limits,
  telemetry, screenshots, and outcome classification are code.

The loop stops for one recorded reason: `OBJECTIVE_COMPLETE`, `ABANDONED`, `TIMED_OUT`, `ACTION_LIMIT`,
`BUDGET_LIMIT`, `TECHNICAL_ERROR`, `SAFETY_STOP`, or `CANCELLED`.

Duplicate-state detection has a ceiling as well. When a persona repeats one screen for
`MAX_RETRIES_SAME_STATE` (5) actions without the state changing, the loop ends the session as `ABANDONED`
with `PATIENCE_EXHAUSTED`, because the handoff treats a user who cannot leave a screen as a user who gave up
rather than a user who hit a technical fault.

## What it writes

```
.artifacts/runs/<run_id>/sessions/<session_id>/
  session.json      outcome, finish reason, counts, checkpoints reached
  events.json       the ordered BehaviorEvent log
  screenshots/      checkpoint-<NAME>.png and final-<n>.png
```

`.artifacts/` is git-ignored. The production worker persists its raw trajectories separately in S3. `writeSessionArtifacts` refuses to write a log that contains any value it was told to protect, which is
covered by a test, so a typed password cannot reach disk unnoticed.

`events.json` is the evidence the report will read. Two properties matter:

- Every event carries `run_id`, `session_id`, `persona_id`, `elapsed_ms`, `url`, `route`, `action_type`,
  `target_descriptor`, `result`, `console_error`, `network_error`, `task_checkpoint`, and `agent_reason_code`.
- Typed values are never recorded. A field records `value_present`, not its contents, and a password field is
  flagged `sensitive_input` instead of being logged.

## Reading a run

```bash
npm run l1:run
```

Every published number is computed from the log by `computeRunMetrics`, never by a model: the runner prints completion,
abandonment, timeout, technical-failure rates, median time-to-value, retry count, and friction signals with
their numerators and denominators.

`retries`, `checkpoints`, and `friction` in that output come from the recorded events only. An empty
denominator prints `n/a`, never `0%`.

## What this does not claim

- It is not a replacement for real beta users, and it does not measure demand.
- It is not AWS, Step Functions, DynamoDB, S3, Nova, or AgentCore Browser. `createUnconfiguredSessionExecutor()`
  still reports `available: false` for those environments.
- One session is not a metric. L1 exercises the local pipeline; population-level findings need L2 and beyond.
- The local policy is a heuristic, not a model. It exists so the loop, guardrails, telemetry, and artefacts can
  be tested without a model in the path, and so a model can be dropped into `AgentPolicyPort` without moving
  anything else.
