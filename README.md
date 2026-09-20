# Centopus

Centopus runs synthetic usability sessions against web products you own or are authorized to test. Its React interface creates a population, starts a run, polls session status, and displays recorded actions and deterministic reports. Synthetic users do not measure demand or replace research with real people.

## Implementation and verification

The application and top-level DynamoDB schema are based on main at `ddcaa6a4feb4ca9c57e494353c5074825ced7fd5`. Selected foundation safeguards are adapted to those contracts.

- Production HTTP entry point: `services/api/src/lambda.ts`.
- Execution: Step Functions -> TypeScript session worker -> cross-account role -> Python Nova Act worker -> AgentCore Browser.
- Evidence: observed browser actions -> raw trajectory in S3 -> BehaviorEvent[] in DynamoDB -> deterministic analytics and report.
- Backend deployment source: `infra/cdk/`. Amplify hosting uses `amplify.yml` and separately configured hosting settings.
- Live View is **not integrated**. The interface polls status; action evidence appears after each session.
- Bounds: 100 users per run, five concurrent workers, 40 actions, 300 seconds maximum per browser session. These are configured limits, not live load-test results.
- Budget: $80 cumulative execution-estimate reservations; $45 default per-run estimate allowance, configurable from $0.01 to $80. Actual AWS billing is not connected.

Offline tests and synthesis do not establish deployment, IAM, authentication, quota, browser access or billing verification. Read [verification status](docs/final-deployment-report.md) and [deployment prerequisites](infra/README.md).

## Local setup

Use Node.js 22.12+ (CI uses Node 22), npm, and Python 3.12 for SDK checks.

```bash
npm ci
npm run check
npm run build
npm run infra:synth
npm run test:python
npm run nova:validate
```

`infra:synth` uses explicitly fictitious validation accounts and does not deploy. Tests mock AWS calls. Python contract tests and plan validation need no SDK or cloud credentials. Full SDK verification uses a Linux Python environment:

```bash
python -m venv .venv
# activate the environment with your shell's activation command
python -m pip install -r services/nova-worker/requirements.txt
python -m pip check
python services/nova-worker/verify_sdk.py
```

Start the UI with `npm run dev`. Copy `apps/web/.env.example` to `apps/web/.env` and configure the actual API and Cognito outputs. VITE_ variables are public. Without an API, the UI reports that it is unavailable.

`npm run dev:demo` serves the owned Fieldwork target at http://127.0.0.1:4174. `npm run l1:run` exercises the separate local heuristic browser adapter (Chrome/Edge required); it is not Nova or AWS execution.

## Documentation

- [Architecture and storage contract](docs/architecture.md)
- [AWS execution and evidence](docs/aws-execution.md)
- [Cost model](docs/cost-model.md)
- [Integration decisions and branches](docs/integration-audit.md)
- [Submission checklist](docs/submission-checklist.md)
- [Demo script](docs/demo-script.md)
- [Submission packet](docs/submission-packet.md)

Internal package names use the @centopus/* scope, matching the GitHub repository at SaiKrishna181707/centopus.
