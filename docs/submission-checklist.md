# First Commit submission readiness

This file is the release gate for Synthetic Beta. A box is checked only when the repository or a recorded
AWS run proves it.

## Core product

- [x] A real local browser session can execute one synthetic persona end to end.
- [x] Session behavior is recorded as structured evidence.
- [x] Metrics are deterministic functions of recorded evidence.
- [x] Findings carry evidence pointers instead of unsupported model claims.
- [x] Budget, origin and action guardrails are centralized.
- [x] A real Nova Act + AgentCore Browser worker exists behind an explicit JSON session-plan boundary.
- [ ] One Nova Act session has been executed successfully in the hackathon AWS account.
- [ ] Nova/AgentCore trace data is adapted into the shared BehaviorEvent schema.
- [ ] Five real AWS sessions run concurrently or in one controlled batch.
- [ ] Twenty real AWS sessions complete reliably.
- [ ] One 100-user run is captured for the demo/report.

## Generic product testing

- [x] The Nova worker does not depend on data-synthetic-checkpoint attributes.
- [x] The Nova prompt gives a goal, persona and boundaries rather than a scripted click path.
- [ ] Generic objective completion evidence is persisted from actual Nova/AgentCore traces.
- [ ] A second authorized staging product, not demo-target, is used as a generalization test.

## AWS / Ship It

- [x] Nova Act worker uses AWS IAM workflow authentication.
- [x] AgentCore Browser is the managed browser runtime for the AWS worker.
- [x] Amplify Hosting build configuration is committed for the npm-workspace monorepo.
- [ ] Hackathon AWS account has the required Nova Act workflow definition.
- [ ] Frontend is connected to AWS Amplify and deployed from main.
- [ ] AWS execution evidence is visible in the demo (AgentCore Live View and/or recording).
- [ ] Cloud-side run/session metadata persistence is connected.
- [ ] Cost alarms/budget guardrails are configured in the AWS account.

## Repository quality

- [x] CI runs Node lint, tests, typecheck and production build.
- [x] CI runs Python worker compile and contract tests without requiring cloud credentials.
- [ ] Submission PR is green.
- [ ] Submission branch is merged to main only after the required checks pass.
- [ ] Main build is green after merge.

## Demo

The three-minute story should be:

1. Paste an authorized staging URL and define one goal.
2. Show a population and select/run a small live batch.
3. Open AgentCore Live View and visibly show an autonomous user making its own decisions.
4. Jump to a completed 100-user run.
5. Show deterministic funnel/friction metrics.
6. Open one failed session and its evidence.
7. Show the final report and limitations.
8. End on the AWS architecture/cost-control slide.

Do not spend demo time on repository structure, CSS, unit-test counts or planned features.
