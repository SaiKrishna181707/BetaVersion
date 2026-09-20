# Centopus final integration audit

## Baseline and scope

`feat/centopus-final` starts at `origin/main` commit
`ddcaa6a4feb4ca9c57e494353c5074825ced7fd5`. Main supplies the newer UI, production
HTTP shapes, top-level DynamoDB records and cross-account Nova execution design.
`feat/product-foundation` remains at `5cf47a2a233de9e42f2723f7654edfadcf62aaed`.
No historical branch was merged, rebased, deleted or rewritten. The integrations
below are adapted source changes, not whole-commit cherry-picks.

## Foundation work adapted

| Foundation source | Useful feature | Adaptation and verification |
| --- | --- | --- |
| `5cf47a2`, `f88efe4`: CDK configuration, data/execution/observability stacks | Explicit configuration, retained/imported storage, scoped IAM, execution limits and interruption handling | New `infra/cdk/stacks.ts` bundles main's three production Node entries, retains its cross-account Python worker and schema, and defines the public judge API with backend-enforced target and execution controls. Template tests and offline synthesis check resources and dependencies. |
| `83b267d`: `services/api/src/aws/budget.ts` | Atomic, retained global reservations | `services/api/src/budget.ts` reserves main's estimate and claims `RUN#/META` in one transaction. Tests cover concurrent starts, exhaustion, rollback and stale persona revisions. No JSON-body storage or automatic refund is introduced. |
| `83b267d`: `services/agent-worker/python/nova_runner.py` | Custom Nova actuator records actual browser actions | `services/nova-worker/evidence.py` emits main-compatible raw steps; main's trace adapter requires observed action/result/time/URL. Python tests cover failures, limits, goal evidence, wrapped stops and cleanup; SDK surface verification checks the installed actuator signatures. |
| `04881af`, `86416f2`, `f88efe4` | Execution validation, identity checks, bounded retries and evidence persistence | Main's API revalidates stored plans, checks population/payload size, and claims sessions before dispatch. Browser side effects have no automatic retry. Worker/finalizer failures do not fabricate evidence references or costs. Production-chain tests exercise main's routes and records. |
| `4aa8c78`, developed further in `83b267d` | Repeated-state stop | The cloud recorder bounds repeated observed states and actions. Main's existing local session-loop tests remain intact. |
| Foundation AWS, Python and browser tests | Failure-focused validation approach | New tests use main's production factories and explicit AWS fixtures. No tests requiring foundation's incompatible storage/API are copied wholesale. |

Additional integration fixes include full DynamoDB pagination, DNS-pinned and
size-bounded product-page retrieval, production frontend API calls without an
operator-login gate, backend-authoritative target validation, cancellation/start
race handling, truthful historical-evidence warnings, and blocking dependency audits.

## Intentionally not ported

| Source | Decision |
| --- | --- |
| Foundation JSON-body/S3 store and API/runtime (`f88efe4`, `83b267d`, `86416f2`) | Incompatible with main's top-level DynamoDB records and frontend response shapes. Only safeguards were adapted. No data migration or wholesale contract replacement is performed. |
| Foundation Nova policy, direct browser runtime and container topology | Would create a competing execution path. Main's cross-account role and Python Nova Lambda remain authoritative. |
| Local multi-run orchestrator and L2 CLI (`04881af`, `4f784a1`) | Separate filesystem storage and scheduling are unnecessary for the production chain. Main's existing single-session local development adapter remains clearly documented. |
| Earlier workspace/API client (`c0783ce`) and purple/carousel UI (`85f83d8`) | Superseded by main's newer product UI; not required for correctness. |
| Original scaffold/local browser (`4734d21`, `7e298ce`) | Main already has the corresponding package structure, deterministic analytics and local browser adapter. Preserve the working baseline. |
| Old environment/deployment copy (`4fcc576`, `5cf47a2`) and smoke/deploy scripts | Resource assumptions and API expectations belong to the old architecture. Replaced by explicit main-compatible configuration and documented live checks; no past deployment claims are adopted. |
| Foundation $250 ceiling and 20-worker option | Do not match main's enforced $80 ceiling, $45 default allowance and five-worker execution bound. |

The preserved foundation branch still has unique source, especially its alternate
local orchestration, deployment tooling and UI. It is not a pending merge queue.
Future reuse requires an explicit adaptation to this branch's contracts.

## Historical branch inventory

Counts below are branch-only / main-only commits at the baseline. Commit divergence
alone does not establish unique source: several heads exactly match trees already
present in main's history.

| Remote branch | Head | Divergence | Classification and disposition |
| --- | --- | --- | --- |
| `feat/product-foundation` | `5cf47a2` | 12 / 32 | Unique alternative infrastructure/backend/tests/UI. Preserve unchanged; selected adaptations listed above. |
| `feat/ui-vision-final` | `f89051f` | 0 / 1 | Newer UI, already merged; main's baseline has the same tree. Content-redundant archive candidate. |
| `feat/ui-vision-chatgpt` | `0ee50f8` | 16 / 16 | Alternative UI/client/component history. Main's newer UI is authoritative. Preserve for review; no missing production requirement identified. |
| `feat/submission-final` | `733726e` | 11 / 30 | Submission implementation/docs; exact tree at main-history `b869f38`. Content-redundant archive candidate. |
| `feat/submission-ready` | `06daf23` | 30 / 32 | Earlier scaffold, local execution, tests, CI, Nova setup and submission docs. Historical differences remain; preserve for review. |
| `fix/release-stress-test` | `cb6b87a` | 46 / 28 | Release tests/fixes/docs; exact tree at main-history `55338d9`. Content-redundant archive candidate. |
| `fix/retry-evidence` | `84020b2` | 4 / 31 | Retry/evidence fixes; exact tree at main-history `960346e`. Content-redundant archive candidate. |
| `chore/submission-metadata` | `23f5ce4` | 2 / 29 | Submission metadata/docs; exact tree at main-history `e0353b7`. Content-redundant archive candidate. |
| `docs/release-verification-refresh` | `6f10229` | 2 / 27 | Verification docs; exact tree at main-history `91940f3`. Content-redundant archive candidate. |

Archive candidates describe source redundancy only. No branch is deleted by this
cleanup; retain any PR/audit history the owner needs. Foundation and final main
remain separate histories after selective adaptation.

## Authoritative paths and limitations

- Storage: [top-level DynamoDB schema](architecture.md), plus retained budget rows.
- Production HTTP: `services/api/src/lambda.ts`; legacy `handler.ts` serves existing
  deterministic tests and is prohibited in production bundles.
- Execution: Step Functions -> TypeScript worker -> cross-account role -> Python
  Nova worker. Direct Python CLI execution is diagnostic and bypasses API reservations.
- Frontend HTTP: `apps/web/src/lib/api.ts`, connected directly to the production API.
- Backend infrastructure: `infra/cdk/`; Bedrock Nova is invoked server-side with
  IAM-scoped model permissions, and GitHub Actions deploys merged `main` builds to Amplify with
  repository-and-branch-restricted AWS OIDC credentials.

No mascot asset exists in the inspected branch history at the requested path; the
existing brand graphic is retained. User-facing text is Centopus. Internal package,
repository, AWS and API identifiers are preserved where compatible.

Live View, actual billing and fresh AWS execution evidence remain unavailable.
Historical screenshots remain historical. Old records receive an unverified-evidence
warning and cannot be silently regenerated as current recorder evidence. See
[validation results and limitations](final-deployment-report.md) and the
[manual submission checks](submission-checklist.md).
