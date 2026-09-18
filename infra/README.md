# Infrastructure

**Status: intended topology and boundaries only.** There is no CDK application and no policy document in this
repository yet, and that is deliberate.

The project targets AWS, but this phase must not invent AWS APIs or SDK usage. Writing a stack against
remembered service action names would produce code that typechecks and then fails on deploy, and it would hide
which permissions the design actually needs. So this directory records the topology and the least-privilege
boundaries, and `infra/cdk` lands when each service surface can be verified against current AWS documentation.

## Intended topology

| Layer | Service | Purpose |
| --- | --- | --- |
| Delivery | CloudFront + S3 | Serves the built front end from `apps/web` |
| Control plane | API Gateway + Lambda | Validation, cost estimation, run creation, status |
| Orchestration | Step Functions | Batches sessions, enforces the run cap between batches |
| Execution | Lambda + browser runtime | Runs one synthetic session per isolated browser context |
| Interpretation | Amazon Bedrock (Nova) | Clusters behaviour and writes narrative only |
| Metadata | DynamoDB | Runs, sessions, events, metrics |
| Evidence | S3 | Screenshots, recordings, event logs, generated reports |
| Observability | CloudWatch | Logs, metrics, alarms, cost anomaly detection |

`amazon-nova-act` and AgentCore Browser are the intended execution runtime. The interface they must satisfy is
already fixed in `packages/contracts/src/execution.ts` (`SessionExecutorPort`), so the runtime choice stays
behind a port and does not leak into analytics or reporting.

## Data flow

```
Browser ──▶ CloudFront ──▶ S3 (static build)
   │
   └─▶ API Gateway ──▶ control-plane Lambda ──▶ DynamoDB (runs)
                                  │
                                  └─▶ Step Functions ──▶ batch dispatch
                                                             │
                                          session Lambda ──▶ browser runtime
                                                             │
                                                     S3 (evidence) + DynamoDB (events)
                                                             │
                              analytics ──▶ DynamoDB (metrics) ──▶ report ──▶ S3
```

## IAM boundaries

One role per service. No shared role. No `*` in an `Action`, and resources scoped by ARN to the specific table,
bucket prefix, state machine, or model.

| Role | May | Must not |
| --- | --- | --- |
| Control plane | Read/write the runs table; start the named state machine | Invoke Bedrock, read evidence objects |
| Session worker | Write events and evidence under its own run prefix; read its own session plan | Read other runs' artefacts, start executions |
| Analytics | Read events and sessions; write metrics | Write evidence, start executions |
| Report | Read metrics; write reports; invoke the narrator model only | Read raw evidence beyond cited pointers, write metrics |
| Orchestrator | Invoke the session worker, read the runs table | Invoke Bedrock |

`infra/policies/README.md` records the authoring rules those documents must follow.

## Guardrails as infrastructure controls

| Guardrail | Control |
| --- | --- |
| `GLOBAL_SPEND_CEILING_USD` | Account-level budget and CloudWatch cost alarm; control plane refuses a run that would cross it |
| `DEFAULT_RUN_HARD_CAP_USD` | Persisted on the run; re-read before each batch dispatch |
| `DEFAULT/MAX_SESSION_SECONDS` | Passed in the session plan and enforced with a hard runtime timeout |
| `DEFAULT/MAX_BATCH_SIZE` | Maximum `Map` concurrency in the Step Functions state machine |
| `MAX_ACTIONS` | Session plan ceiling; the worker stops the session when reached |
| `MAX_RETRIES_SAME_STATE` | Enforced inside the session loop, not by Step Functions retries |
| Authorized domains only | Validated at the API boundary and re-checked in `reviewSessionPlan` |

## Before implementing, verify against current AWS documentation

1. The exact service action namespace and resource ARNs for the browser runtime (Nova Act and AgentCore Browser).
2. Whether Bedrock model invocation needs a provisioned throughput or a cross-region inference profile ARN, and
   how that is expressed in a policy resource.
3. Current DynamoDB and S3 pricing, plus Nova Act metering, to replace the placeholder rates in
   `HANDOFF_COST_MODEL` (`docs/cost-model.md` explains the arithmetic).
4. Whether Step Functions or the worker owns the session timeout, and how a cancelled execution terminates a
   live browser session.
5. Bedrock data-retention and logging behaviour, given the rule that no secrets may reach a prompt or a log.