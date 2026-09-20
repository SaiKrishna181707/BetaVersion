# Centopus architecture

Main's newer frontend, API shapes and top-level DynamoDB schema are authoritative. The deterministic foundation test handler is excluded from production bundles.

```text
React frontend (Amplify build configuration)
  -> Cognito operator sign-in (authorization code + PKCE)
  -> API Gateway HTTP API (JWT authorizer)
  -> services/api/src/lambda.ts
  -> atomic run claim and budget reservation in DynamoDB
  -> Step Functions inline Map (up to five workers)
  -> services/agent-worker/src/worker-lambda.ts
  -> STS AssumeRole, restricted by principal ARN and external ID
  -> services/nova-worker/lambda_handler.py
  -> AgentCore Browser + Nova Act instrumented actuator
  -> observed RawNovaStep[]
  -> S3 raw trajectory + DynamoDB BehaviorEvent[]
  -> services/report/src/finalizer.ts
  -> deterministic metrics + evidence-linked report
  -> DynamoDB report + private S3 report -> authenticated API -> React
```

Cognito provides an operator workspace. Health reports configuration availability, not a live AWS probe. Product intelligence and editable persona narratives use low-cost Amazon Nova models through Bedrock; they never supply behavioral events. Only Nova Act browser evidence can affect measured outcomes.

When `BEDROCK_ROLE_ARN` is configured, the control-account API and finalizer obtain short-lived STS credentials for that role and invoke Nova in the agent account. This keeps Amplify, API Gateway, Step Functions, DynamoDB, and S3 in the control account while avoiding duplicate infrastructure in the Bedrock-enabled account.

## Authoritative storage

| pk | sk | Data |
| --- | --- | --- |
| RUN#<run> | META | Configuration, status, estimate, execution ARN, timestamps |
| RUN#<run> | PERSONA#<persona> | Structured persona |
| RUN#<run> | SESSION#<session> | Session metadata for run listing |
| SESSION#<session> | META | Mirrored metadata for session detail |
| SESSION#<session> | EVENT#<sequence> | Recorded event; legacy timestamp-prefixed keys remain readable |
| RUN#<run> | METRICS, FINDINGS, REPORT | Derived results; REPORT includes artifact_key after S3 persistence |
| RUN#<run> | RESERVATION | Retained estimate reservation |
| BUDGET#GLOBAL | META | Retained cumulative reserved_cents |

Ordinary records carry seven-day ttl; deletion is asynchronous. Reservations do not expire. Imported tables require manual TTL/configuration verification. S3 uses nova-trajectories/<session>.json and reports/<run>.json. No fake screenshot/video references are published.

Queries read all DynamoDB pages. The finalizer rejects identity mismatches rather than reassigning events. Workers claim queued sessions before browser invocation; terminal duplicate deliveries do not open another browser. Automatic retries of browser side effects are disabled.

## States and interruptions

Runs start QUEUED. Atomic reservation claims PROVISIONING; a successful orchestration start records ACTIVE. Missing configuration never reports success. Uncertain launch failures retain reservations and require reconciliation rather than automatic spending retries.

Missing evidence cannot prove success. A run may finish processing when users abandon; technical session failures make the run fail. Funnels use configured checkpoints, including unreached stages.

Step Functions catches failures and waits for in-flight workers before finalization. EventBridge reconciliation handles failed, timed-out and aborted executions after 480 seconds. Cancellation stops orchestration; an already-invoked browser can continue until its session timeout. It is not an immediate browser-kill guarantee.

An in-flight session can retain an observed completed outcome after run cancellation;
queued sessions close as cancelled during reconciliation. Run cancellation remains
terminal and is never overwritten by a delayed finalizer. Reports can therefore
contain completed sessions within a cancelled run. Failed launch persistence can
leave an incomplete population requiring manual reconciliation; it is not reported
as a successful run.

New runs, session records and report records identify evidence schema version 2.
Historical records remain readable with an unverified-evidence warning. Legacy
cost/video fields are not certified by serving them again, and legacy report
downloads are withheld until reviewed; persisted historical data is not deleted.

See [infrastructure scope](../infra/README.md). Generated cdk.out is not source. The preserved foundation branch is historical, not an alternative deployment path for this application.
