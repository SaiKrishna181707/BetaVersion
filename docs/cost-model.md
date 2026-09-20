# Centopus cost model and enforcement

GUARDRAILS in packages/contracts/src/model.ts is authoritative. CDK imports it instead of retaining foundation's $250 limit.

| Setting | Value | Meaning |
| --- | --- | --- |
| Global execution allowance | $80 | Cumulative admitted estimates in BUDGET#GLOBAL / META |
| Default run allowance | $45 | Configurable from $0.01 to $80 in whole cents |
| CDK AWS Budget | $80/month | Control-account notification, not a hard stop or dual-account aggregate |
| Actual cost | Unavailable (null) | No AWS billing ingestion |

The older $40 per-run claim had no corresponding enforcement. Main already used a $45 default and allowed an explicit cap up to $80; this is retained. The ledger atomically reserves the full estimate while claiming a queued run. Duplicate starts cannot reserve twice; concurrent runs cannot exceed $80 of admitted estimates. Reservations do not expire or refund automatically. Reconcile previous usage when importing existing storage.

## Dated estimate inputs

HANDOFF_COST_MODEL is handoff-2026-09-17-v1, basis HANDOFF_SNAPSHOT.

| Input | Value |
| --- | --- |
| Nova Act agent hour | $4.75 |
| Browser minute | $0.00123 |
| Persona allowance | $0.01 |
| Run allowance | $0.10 |
| Contingency | 20% |

These are development inputs, not verified current AWS pricing. Maximum-duration arithmetic is conservative only within this model, not a guaranteed upper bound on an AWS bill. Gemini and other account usage are not comprehensively metered.

```text
browser_minutes = users * maximum_session_seconds / 60
base_microusd = browser_minutes / 60 * 4750000
             + browser_minutes * 1230 + users * 10000 + 100000
total_cents = ceil(base_microusd * 1.20 / 10000)
```

The tested example of five users at 180 seconds produces 15 browser minutes and $1.63. The maximum 100 users at 300 seconds produces $49.56, exceeding the default $45 allowance. Five-worker concurrency controls parallelism, not total modeled cost.

Budgets/SNS must be verified after deployment. Alerts do not terminate browsers or aggregate both accounts. Duration-based formulas must never be written to actual_cost_cents; it stays null until independently supported billing data is integrated.
