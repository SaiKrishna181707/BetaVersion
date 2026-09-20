# IAM boundaries

Authoritative IAM statements live in infra/cdk/stacks.ts.

The control worker can assume only the configured agent bridge with its external ID. Trust also restricts the calling principal ARN; the bridge can invoke only the Nova worker. The agent Lambda has Nova workflow and managed AgentCore Browser permissions, with no control-table or artifact-bucket grants.

The control API accesses run state, starts/stops its state machine, reads report/trajectory prefixes, and invokes only the configured Nova foundation models. Worker/finalizer storage grants stay in the control account. API Gateway uses Cognito JWT authorization; the CDK-deployed Lambda also requires an authorizer subject.

These are synthesized policies, not proof of effective permissions in AWS. Existing roles, boundaries, organization policies and deployed authorizers require verification. This is a shared operator workspace, not multi-tenant authorization. Never commit credentials or secret values.

## GitHub OIDC deployment-role bootstrap

The production deployment workflows use short-lived GitHub OIDC credentials. Repository renames change the GitHub OIDC `sub` claim, so the effective AWS role trust must be kept in sync with the source-controlled policies here.

- `backend-deploy-role-trust-policy.json` is the trust policy for `CentopusBackendGitHubDeployRole`.
- `amplify-deploy-role-trust-policy.json` is the trust policy for `CentopusAmplifyGitHubDeployRole`.

Both policies are restricted to this repository's `main` branch and the AWS STS audience. Applying these files is an AWS bootstrap/admin action; committing them does not change IAM by itself. With an AWS principal authorized to update role trust in account `643700104680`, apply them explicitly:

```bash
aws iam update-assume-role-policy \\
  --role-name CentopusBackendGitHubDeployRole \\
  --policy-document file://infra/policies/backend-deploy-role-trust-policy.json

aws iam update-assume-role-policy \\
  --role-name CentopusAmplifyGitHubDeployRole \\
  --policy-document file://infra/policies/amplify-deploy-role-trust-policy.json
```

After any trust-policy change, re-run both production deployment workflows and verify the backend `/health` release SHA before treating the release as live. Do not broaden either role to wildcard repositories or branches just to make a deployment pass.
