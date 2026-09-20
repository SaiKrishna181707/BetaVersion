# AWS execution and evidence

The intended deployment uses two explicitly configured accounts. Account IDs, resource ARNs and deployment status are not inferred from historical documents. Source and offline tests do not establish current live execution.

| Role | Source entry point |
| --- | --- |
| HTTP API | services/api/src/lambda.ts |
| Session dispatcher | services/agent-worker/src/worker-lambda.ts |
| Agent container | services/nova-worker/lambda_handler.py:handler |
| Finalizer/reconciliation | services/report/src/finalizer.ts |

scripts/build-lambdas.mjs builds three Node bundles with index.handler and rejects inclusion of services/api/src/handler.ts. That module remains a deterministic test transport.

## Evidence

The Python worker validates the plan, starts AgentCore Browser and uses the pinned Nova SDK's custom actuator. The adapted foundation recorder wraps actual browser methods and captures timing, actions, outcomes and observations. Typed values, final model responses and SDK programs are not persisted; SDK logs are temporary.

Trace adaptation requires an observed action, result, valid timestamp, elapsed time and URL. It does not default actions to clicks, outcomes to success, invent elapsed time, infer goals from URL substrings, or generate events from final model text. Hover counts toward the browser action limit but is not mislabeled as a click. Cloud screenshot references remain null because this recorder does not upload screenshots.

Completion requires an explicitly configured final DOM checkpoint (data-synthetic-checkpoint). Use the optional New Run field to enter checkpoint_plan in order. Fieldwork markers are OPEN_APP, CREATE_PROJECT, INVITE_TEAMMATE; a dashboard-only objective can use OPEN_APP. Uninstrumented sites still provide action/friction evidence, but completion remains unverified. A model statement never substitutes for this proof.

The recorder bounds actions, time and repeated states, restricts requests/navigation to authorized hosts, and blocks detected credential/payment/destructive controls. These are application controls, not universal harmful-action detection or proof of network-level isolation. External CDN/login hosts outside the authorized set can fail to load.

Raw trajectories are saved before events are published. Persistence failures fail the session without inventing S3 references. Report downloads are linked only after successful S3 persistence. Runtime failures may retain partial evidence.

## Live View and billing

live_view_url is null. There is no endpoint provisioning/refresh/authentication path or WebRTC player. Conditional frontend links are compatibility hooks. Status polling every 2.5 seconds is not browser video or streamed action telemetry. An AWS console viewer does not establish application integration.

actual_cost_cents is null. Duration-based formulas are not billing measurements. See [cost model](cost-model.md) and [historical evidence limitations](final-deployment-report.md).

## Required AWS verification

Follow [deployment prerequisites](../infra/README.md). Start with one authorized session. Inspect its execution ARN, both session records, raw trajectory, events, metrics and report. Verify every cited event/reference. Exercise cancellation, target rejection, worker failure, reservation exhaustion and denied operator access before increasing the cohort. A 100-user run or 20-user concurrency is not established by these instructions.
