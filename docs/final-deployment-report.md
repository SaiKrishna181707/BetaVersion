# Centopus repository verification status

This records repository verification, not a deployment certificate. No AWS deployment, live browser execution, current resource existence, quota or billing result was established during cleanup.

Main baseline: ddcaa6a4feb4ca9c57e494353c5074825ced7fd5. The integration branch preserves its application/storage contracts and adapts selected foundation safeguards. See [integration provenance and branch inventory](integration-audit.md).

## Local verification on 2026-09-20

These checks ran against the final integration source before commit. Node checks
used Windows ARM, Node 24.19.0 and npm 11.17.0; CI uses Node 22. Browser tests used
installed Edge. SDK/dependency checks used Ubuntu under WSL with Python 3.12 on ARM.

| Check | Observed result |
| --- | --- |
| `npm ci` | Passed; root lockfile installed successfully |
| `npm audit --audit-level=high` | Passed; zero vulnerabilities |
| `npm run check` | Passed: ESLint, all 148 Node unit/integration tests, TypeScript and Vite production build |
| `npm run build` | Passed independently as well as through check |
| `npm run infra:synth` | Passed; two offline stacks, explicit fixture accounts, no AWS deployment |
| `npm run test:browser` | Two tests passed: complete product/population/execution/report/session flow with explicit AWS fixtures; operator PKCE/state/token/sign-out flow with an explicit identity-provider fixture |
| Python compilation | `python -m compileall -q services/nova-worker` passed |
| Python tests | 25 tests passed on Windows and Linux; no AWS calls |
| `npm run nova:validate` | Example plan accepted without AWS execution |
| Linux install from `requirements.txt` | Passed; resolved runtime dependency versions pinned |
| Linux `python -m pip check` | No broken requirements |
| Linux `python services/nova-worker/verify_sdk.py` | AgentCore lifecycle and Nova custom-actuator signatures verified without AWS calls |
| Linux `python -m pip_audit --local` | No known vulnerabilities in the complete installed environment |
| Repository hygiene | `git diff --check` passed; no broken local Markdown targets or unintended old product branding; targeted credential-pattern scan found no matches |

New regression coverage includes cumulative/duplicate reservations, persona-edit
races, paginated storage reads, missing configuration, evidence persistence failure,
remote response identity/version checks, fast finalization, cancellation races,
legacy evidence/cost warnings, model-response rejection, wrapped Nova stops and
browser cleanup failures. Existing deterministic analytics/local-browser tests remain.

The browser report screenshot in ignored `.artifacts/` is an offline test artifact,
not AWS evidence. The targeted credential scan does not certify all repository history.

## Remaining verification and warnings

- npm reports ESLint 9.39.5 as outside support. No known audit vulnerability was
  reported; a future major upgrade should be reviewed with its config/plugins.
- npm 11 reports esbuild install scripts not covered by its local allowScripts
  policy. The required native binaries and all builds/tests worked; no global
  script-approval setting was changed.
- CDK reports 83 unconfigured feature flags. Synthesis succeeds; future flag
  changes require reviewing their CloudFormation diff.
- The Docker daemon was unavailable. No Lambda container image build or x86_64
  runtime execution was verified. The upstream Lambda image tag is not digest-pinned.
- Native Windows ARM SDK installation was unsuitable; Linux SDK checks succeeded.
  Python auditing uses the installed environment, covering transitive packages
  without requiring a second temporary virtual environment.
- Fresh AWS account/resource existence, effective IAM, Cognito login, quotas,
  notification delivery, reservation adoption, browser execution and billing all
  require the manual checks in the submission checklist. No AWS authentication was attempted.
- A final GitHub Actions result must be associated with the pushed commit. Local
  results above do not claim a hosted CI result.

## Historical evidence

Previous documentation reported run-mu8qcp85-ryxcm as 100 Fieldwork sessions with five concurrent workers, 100 completed sessions and a $6.15 estimate. The tracked repository has four screenshots (live_view_proof.png, live_view_proof_action.png, nova_autonomous_friction_solved_step11.png, nova_autonomous_friction_solved_step12.png), but no complete exported execution history, matching 100-session event dataset or billing record that independently establishes those numbers.

The older worker could classify completion from final model text and supply missing action/outcome/timing values while parsing HTML. Its 100% completion claim cannot be carried forward as evidence-grounded verification of this implementation. Preserve the screenshots as historical artifacts; their filenames do not prove application Live View integration. No historical screenshot is relabeled as a new run.

Historical accounts, ARNs and URLs are not certified current. Live View remains null. Billing is not connected. Offline tests simulate AWS responses; successful synthesis does not establish deployed IAM/runtime behavior. See [remaining live checks](submission-checklist.md).
