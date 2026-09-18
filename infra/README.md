# Infrastructure

## Current status

The repository now contains a real Nova Act + AgentCore Browser execution worker in
`services/nova-worker/` and an Amplify Hosting build specification. Full control-plane infrastructure
(Step Functions/DynamoDB/S3/CDK) is still a release gate rather than something the repository pretends is
already deployed.

## Submission topology

| Layer | Service | Purpose |
| --- | --- | --- |
| Delivery | AWS Amplify Hosting | Builds and serves `apps/web` from `main` |
| Agent reasoning | Amazon Nova Act | Chooses browser actions from persona + objective |
| Browser | Amazon Bedrock AgentCore Browser | Isolated managed browser, Live View/recording |
| Control plane | API Gateway + Lambda (target) | Run validation, creation, status |
| Orchestration | Step Functions (target) | Controlled 1 → 5 → 20 → 100 session dispatch |
| Metadata | DynamoDB (target) | Runs, sessions, events, metrics |
| Evidence | S3 (target) | Screenshots, recordings, event logs, reports |
| Observability | CloudWatch | Logs, alarms and cost controls |

## Real execution today

`services/nova-worker/worker.py`:

1. validates one session plan,
2. rejects unsafe/non-authorized targets before cloud execution,
3. enters a Nova Act IAM workflow,
4. creates an AgentCore Browser session,
5. connects Nova Act to the browser over CDP,
6. executes the goal with max-step/time limits,
7. returns an explicit result or explicit failure.

This is the first production-shaped AWS path. The next infrastructure milestone is persistence/orchestration,
not another local browser implementation.

## Target data flow

```text
Amplify frontend
      ↓
API Gateway
      ↓
control Lambda ── run/session metadata ── DynamoDB
      ↓
Step Functions
      ↓ controlled batches
Nova Act workflow
      ↓
AgentCore Browser
      ↓
trace / recording / screenshots
      ↓
S3 + event adapter
      ↓
deterministic analytics
      ↓
report
```

## IAM boundaries

Use separate roles for the control plane, session worker, analytics and report paths. Session execution should
have only the Nova Act/AgentCore permissions and resources needed for its own run. Do not use wildcard
administrative policies in the submitted architecture.

The real worker uses AWS IAM workflow authentication; it intentionally does not depend on a Nova Act API key.

## Guardrails as infrastructure controls

| Guardrail | Control |
| --- | --- |
| Global spend ceiling | AWS Budget/alert plus control-plane admission check |
| Per-run hard cap | Persisted run value, checked before every batch |
| Session maximum | Worker/agent timeout |
| Batch maximum | Step Functions Map/concurrency configuration |
| Action maximum | Nova Act `max_steps` |
| Authorized targets | API validation plus worker-side host allowlist |
| Destructive actions | Agent prompt/policy boundary plus staging-account design |

## Deployment order

1. Merge only green CI into `main`.
2. Connect `main` to Amplify as a monorepo app at `apps/web`.
3. Configure/verify the Nova Act workflow definition in `us-east-1`.
4. Execute one owned HTTPS staging target through AgentCore Browser.
5. Capture Live View/recording evidence.
6. Add persistence and batch orchestration only after one real session works.
7. Scale 1 → 5 → 20 → 100.

See `docs/aws-execution.md` and `docs/submission-checklist.md`.
