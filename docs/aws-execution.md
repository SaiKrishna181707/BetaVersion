# AWS execution path

The AWS milestone is intentionally smaller than the final distributed architecture: prove one real autonomous
user first, then scale the exact same session-plan contract.

## Current real worker

`services/nova-worker/worker.py` accepts one JSON session plan and runs it with:

- Nova Act workflow mode using AWS IAM authentication,
- Amazon Bedrock AgentCore Browser over CDP,
- the persona and objective as natural-language behavior context,
- explicit origin, destructive-action, purchase and access-control boundaries.

The implementation follows the current Nova Act/AgentCore Browser integration pattern. Nova Act is currently
documented in US East (N. Virginia), so the default region is `us-east-1`.

## L2 validation sequence

1. Deploy `demo-target` or another owned staging app to a public HTTPS URL.
2. Copy `services/nova-worker/plan.example.json`.
3. Replace the placeholder target and allowlist with the owned hostname.
4. Configure AWS credentials and a Nova Act workflow definition.
5. Run `--validate-only`.
6. Run one real session.
7. Watch it in AgentCore Browser Live View.
8. Save the resulting workflow/session identifiers and recording evidence for the submission.

## Why this is separate from the TypeScript local executor

The local Playwright adapter exists to test the deterministic loop, telemetry and analytics without cloud cost.
The AWS worker exists to prove the final autonomous-agent runtime. They share the same session-plan idea but
must not pretend to have identical telemetry until a real trace adapter exists.

The project must never create plausible BehaviorEvent rows by paraphrasing Nova's final response. The adapter
must be built from actual browser/workflow trace data.

## Scale path

- L2: 1 AWS synthetic user.
- L3: 5 sessions.
- L4: 20 sessions with a controlled concurrency limit.
- L5: 100 sessions, normally 5 batches of 20.

The 100-user requirement describes the population tested, not a requirement that all 100 browsers start in the
same millisecond.

## Frontend hosting

`amplify.yml` is configured for the npm-workspace monorepo and builds from the repository root. In the
Amplify console, connect the repository, choose `main`, mark it as a monorepo, and set the app root to
`apps/web`. The console should set `AMPLIFY_MONOREPO_APP_ROOT=apps/web`.

The live frontend alone does not satisfy the project goal; the demo must also show a real AWS browser run.
