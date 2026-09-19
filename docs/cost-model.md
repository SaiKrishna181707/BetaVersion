# Cost model

Every number the product shows before a run is produced by `estimateCost` in
`packages/contracts/src/cost.ts`. It is pure arithmetic over the configured maximums, and it is pinned by
`tests/unit/cost.test.ts`. No model, no sampling, and no estimate-on-estimate.

## Rates

Rates live in the dated `HANDOFF_COST_MODEL` (`handoff-2026-09-17-v1`), whose basis is `HANDOFF_SNAPSHOT`:

| Input | Microusd | Displayed |
| --- | --- | --- |
| `nova_act_hour_microusd` | 4,750,000 | $4.75 per agent hour |
| `browser_minute_microusd` | 1,230 | $0.00123 per browser minute |
| `persona_allowance_microusd` | 10,000 | $0.01 per persona |
| `run_allowance_microusd` | 100,000 | $0.10 per run |
| `contingency_percent` | 20 | 20% |

These are **example development inputs**, not an AWS quote. They must be replaced with verified AWS prices and
real metering before execution is enabled. The New Run cost panel renders this table directly from the model,
so the explanation can never drift from the arithmetic.

## Arithmetic

```
browser_minutes = user_count × max_session_seconds / 60
max_actions     = user_count × GUARDRAILS.MAX_ACTIONS

base_microusd = (browser_minutes / 60) × nova_act_hour_microusd
              + browser_minutes × browser_minute_microusd
              + user_count × persona_allowance_microusd
              + run_allowance_microusd

total_cents   = ceil(base_microusd × (100 + contingency_percent) / 100 / 10_000)
```

It is an **upper bound**: it prices the configured maximum duration for every session, not the duration a
session actually used. Real metering will replace it once execution exists. `max_actions` is a cap, not a cost
driver at these rates.

Rounding happens exactly once, upward, at the end. A raw 42.1428 cents reports 43, never 42.

## Worked example

The default form values (`user_count: 5`, `max_session_seconds: 180`):

```
browser_minutes = 5 × 180 / 60                       = 15
base_microusd   = (15 / 60) × 4,750,000  = 1,187,500
                + 15 × 1,230             =    18,450
                + 5 × 10,000             =    50,000
                + 100,000                =   100,000
                                         = 1,355,950
total_cents     = ceil(1,355,950 × 1.20 / 10,000)   = 163
```

So the panel shows **$1.63** for that run. This exact value is asserted in `tests/unit/cost.test.ts`.

## Guardrail interaction

- `exceeds_run_cap` compares the estimate against the run's own `run_hard_cap_usd`. The form blocks review and
  focuses the budget field while this is true.
- `exceeds_global_ceiling` compares a single run against `GLOBAL_SPEND_CEILING_USD`. Because the global
  ceiling is **cumulative across all runs**, one run cannot reach it with these rates: the largest permitted
  run (100 users × 300 seconds) prices at 4,956 cents, or **$49.56**, against a $80 ceiling. In that
  configuration the default $45 per-run cap is what actually binds, and `exceeds_run_cap` is true.

## What happens next

The real cost path will record metered seconds and token usage per session, persist them with the session, and
compare the accrued total against `run_hard_cap_usd` before every batch launch and every new session. The
executor port already carries `remaining_budget_cents` for that reason, and
`services/agent-worker` refuses to review a session plan with no remaining budget.