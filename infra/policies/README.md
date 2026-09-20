# IAM boundaries

Authoritative IAM statements live in infra/cdk/stacks.ts.

The control worker can assume only the configured agent bridge with its external ID. Trust also restricts the calling principal ARN; the bridge can invoke only the Nova worker. The agent Lambda has Nova workflow and managed AgentCore Browser permissions, with no control-table, Gemini-secret or artifact-bucket grants.

The control API accesses run state, starts/stops its state machine, reads report/trajectory prefixes, and optionally reads one configured Gemini secret. Worker/finalizer storage grants stay in the control account. API Gateway uses Cognito JWT authorization; the CDK-deployed Lambda also requires an authorizer subject.

These are synthesized policies, not proof of effective permissions in AWS. Existing roles, boundaries, organization policies and deployed authorizers require verification. This is a shared operator workspace, not multi-tenant authorization. Never commit credentials or secret values.
