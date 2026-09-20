# Centopus infrastructure source of truth

infra/cdk/stacks.ts defines the backend for main's application/storage contract. It is the sole supported backend infrastructure path on this branch. Foundation's alternative stacks remain on its historical branch.

| Component | Repository definition | Verification boundary |
| --- | --- | --- |
| DynamoDB / S3 | CDK creates retained resources or imports supplied names | Imported TTL, encryption, IAM and lifecycle settings need verification |
| API Gateway | Public HTTP API for the judge-facing product; Lambda and service permissions remain least-privilege | Deployed route/CORS behavior needs testing |
| API / worker / finalizer | Explicit bundled Lambda entries | Bundling is not deployment evidence |
| Step Functions | Inline Map, five-worker bound, timeout, catches, reconciliation | Quotas and interruption behavior need live verification |
| Budgets / SNS / Lambda alarms | $80 monthly control-account notification, 80%/100% thresholds | Confirm subscription/delivery; no dual-account aggregation or billing hard stop |
| Agent Lambda / Nova workflow | Docker image and workflow definition in CDK | Docker/ECR deployment and service/model access need verification |
| Cross-account IAM | Principal ARN + external ID restriction, invoke-only bridge | Verify actual trust and SDK permissions |
| AgentCore Browser | Code uses managed aws.browser.v1 | No custom browser resource is created; service availability is external |
| Amplify | amplify.yml builds web workspace | Hosting app, branch connection, domain and environment remain manually configured |
| Bedrock Nova | API and finalizer use IAM-scoped InvokeModel grants | No provider API secret is required or committed |
| Live View | Not implemented | No operational claim |

## Reproduce locally

```bash
npm ci
npm run check
npm run infra:synth
```

Synthesis uses fictitious 111111111111 / 222222222222 account fixtures and writes .artifacts/cdk-validation. It does not deploy or imply these accounts exist. Node and CDK share the root lockfile; do not install a second dependency tree inside infra/cdk.

## Real deployment configuration

Export the settings in .env.example, including CENTOPUS_CONTROL_ACCOUNT, CENTOPUS_AGENT_ACCOUNT, AWS_REGION, AMPLIFY_ORIGIN and an operator-selected CROSS_ACCOUNT_EXTERNAL_ID. CDK does not load .env automatically. Authenticate to the intended accounts with your normal AWS profile/SSO process. Stop when credentials are unavailable.

Existing resources are not automatically migrated or adopted. Set STATE_TABLE and ARTIFACT_BUCKET to import main-schema data resources without replacing them. Without these variables, CDK creates new retained resources. Never import foundation's JSON-body table. Review npm run infra:diff before deployment. Account bootstrapping, cross-account deployment trust and Docker are prerequisites. The project does not configure that bootstrap trust for you.

npm run infra:deploy is the explicit deployment command, with CDK approval for permission broadening. It was not run during cleanup. Deploy each stack using credentials authorized for that account. Stable configured role/function names avoid cross-account CloudFormation references.

Configure the existing Amplify branch with VITE_API_BASE_URL from the control-stack output. Its origin must exactly match AMPLIFY_ORIGIN. Ensure Amazon Nova Micro and Nova Lite are available in the deployment region.

The admission ledger starts at zero on a new table. Reconcile prior usage and conservatively seed reservations before adopting an existing table; otherwise previous spend is outside the ledger. Failed/cancelled runs do not refund automatically. Budget notifications do not enforce billing limits.

Complete the [AWS verification steps](../docs/aws-execution.md) before declaring a production release.
