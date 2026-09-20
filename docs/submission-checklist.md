# Centopus submission checklist

Checked items describe repository implementation. Live checks remain separate until current evidence supports them.

- [x] Main's newer frontend, API shapes and top-level DynamoDB schema are the baseline.
- [x] One production HTTP entry point and cross-account execution path are defined.
- [x] Foundation history is preserved; useful safeguards are adapted.
- [x] User-facing branding is Centopus; internal identifiers remain stable.
- [x] Shared allowances are $80 cumulative reservations and $45 default per run.
- [x] npm audit at high severity is blocking; CI also audits Python dependencies.
- [x] Live View is described as unimplemented.
- [x] Actual cost is unavailable without billing evidence.
- [x] Events require observed actions/results/timing; completion requires explicit checkpoints.
- [x] CDK scope distinguishes managed resources from manual/imported dependencies.
- [ ] Attach the final commit's green GitHub Actions result.
- [ ] Verify actual accounts, deployment outputs and imported storage schema/configuration.
- [ ] Verify Cognito login, JWT issuer/scope enforcement and operator provisioning.
- [ ] Verify cross-account trust, AgentCore/Nova permissions, quotas and container execution.
- [ ] Reconcile prior usage when adopting storage and verify budget notification delivery.
- [ ] Record a fresh one-user AWS run with raw trajectory, event rows, statuses, report and commit SHA.
- [ ] Verify failures, cancellation, interrupted-run reconciliation and exhausted reservations in AWS.
- [ ] Attach larger-cohort evidence before making performance claims.
- [ ] Record the final Centopus demo and confirm all artifacts exist.

See [verification status](final-deployment-report.md) for checks actually executed.
