# infra/cdk

Planned home of the CDK application. Not created yet: see `../README.md` for why the AWS surface is deferred
until it can be verified against current documentation.

Intended layout once it lands:

```
infra/cdk/
  bin/app.ts            stack wiring and environment selection
  lib/network-stack.ts  (not required: API Gateway and Lambda are regional)
  lib/data-stack.ts     DynamoDB tables, the evidence bucket, retention rules
  lib/api-stack.ts      API Gateway routes and the control-plane Lambda
  lib/execution-stack.ts Step Functions state machine and the session worker
  lib/observability.ts  log groups, metrics, alarms, budget
  cdk.json
  package.json          aws-cdk-lib, constructs, cdk CLI
```

`infra/cdk` will be its own package and will not be part of the root TypeScript project, so the front end and
service builds stay independent of the CDK toolchain and its install size. Least-privilege roles are defined
beside the resources they apply to, and the checks in `../policies/README.md` apply to every grant.