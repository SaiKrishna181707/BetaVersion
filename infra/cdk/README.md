# AWS execution

This CDK application wires the existing data, execution, API, and web stacks: DynamoDB,
S3 evidence, the hosted demo, AgentCore Browser, Nova Act, Step Functions, Lambda,
API Gateway, Amplify, and CloudWatch. Each session uses an independent AgentCore browser session.

From the repository root, install infrastructure dependencies with `npm ci --prefix infra/cdk`,
then verify with `npm run test --prefix infra/cdk` and `npm run synth --prefix infra/cdk -- --quiet`.

With Docker running and an authenticated AWS CLI (`aws sts get-caller-identity`), run
`npm run aws:deploy`. The script deploys these stacks, publishes the existing UI, and runs
the real five-session AWS smoke test against the deployed demo. Configuration is read from
environment variables in `lib/config.ts`; no account IDs or credentials belong in source.
CDK deployment requires the target account/region to be bootstrapped.

Deployment outputs are saved to `.artifacts/aws-outputs.json`. Passing unit tests or synthesis
are not proof of AWS execution: the smoke test requires real traces, downloadable evidence,
deterministic metrics, and the final report.
