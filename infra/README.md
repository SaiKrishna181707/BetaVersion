# Infrastructure Topology & Dual-Account Architecture

Synthetic Beta implements a production-grade **dual-account architecture** designed for strict isolation between the customer-facing control plane and the sandboxed agent execution environment.

---

## Canonical Dual-Account Layout

```text
========================================================================================
CONTROL PLANE: Kittu Account (643700104680) — Region: us-east-1
========================================================================================
├── AWS Amplify Hosting: synthetic-beta-web
│   ├── Production App: https://main.d1s2dm4wj8xxb.amplifyapp.com
│   ├── Demo Target 1: /demo-target/ (Fieldwork SaaS Collaboration App)
│   └── Demo Target 2: /demo-target-checkout/ (ShopPulse E-Commerce Checkout)
├── Amazon API Gateway: synthetic-beta-http-api (ID: fkvvrndb17)
│   └── Endpoint: https://fkvvrndb17.execute-api.us-east-1.amazonaws.com
├── Amazon Cognito User Pool: synthetic-beta-users
├── Amazon DynamoDB: SyntheticBetaState (Single-table schema, on-demand capacity, 7-day TTL)
├── AWS Step Functions: synthetic-beta-run-orchestrator (Distributed Map state machine)
├── AWS Lambda Handlers:
│   ├── synthetic-beta-api (HTTP API controller & plan admission)
│   ├── synthetic-beta-session-worker (Cross-account agent dispatch & trace adaptation)
│   └── synthetic-beta-finalizer (Deterministic metric reduction & report compiler)
├── Amazon S3 Artifacts: synthetic-beta-artifacts-20260919-k7m4q2
└── AWS Budgets & SNS: SyntheticBetaSpendLimit ($80 Global Ceiling, $40 Run Cap, SNS Alerting)

                                       │
                         sts:AssumeRole with ExternalId
                                       ▼

========================================================================================
AGENT EXECUTION PLANE: Vivek Account (768669378827) — Region: us-east-1
========================================================================================
├── Cross-Account IAM Role: SyntheticBetaAgentExecutionRole
│   └── Trust policy scoped strictly to synthetic-beta-session-worker execution role
├── Amazon Bedrock AgentCore Browser: SyntheticBetaBrowser (Runtime ID: aws.browser.v1)
│   ├── Headless Chromium instances in isolated micro-VMs
│   ├── WebSocket Automation Stream (CDP port for agent actions)
│   └── WebRTC Live View Stream (Real-time operator inspection stream)
├── Amazon Nova Act:
│   ├── Workflow Definition: synthetic-beta-browser-session
│   └── Foundation Model: nova-act-v1.0 (Multimodal visual browser reasoning)
└── Amazon S3 Trajectories: synthetic-beta-artifacts-vivek-20260919
    └── Raw Nova Act trajectory logs, CDP frame dumps, and action timelines
========================================================================================
```

---

## Service Catalog & Resource Specifications

### 1. Control Plane (Account `643700104680`)

| Service | Resource Name / ID | Configuration & Purpose |
| --- | --- | --- |
| **Amplify Hosting** | `synthetic-beta-web` | Continuous deployment from `main`. Hosts Vite React SPA and static demo targets. |
| **Demo Target 1** | Route `/demo-target/` | Fieldwork SaaS app with discoverability traps, layout shifts, and retry traps. |
| **Demo Target 2** | Route `/demo-target-checkout/` | ShopPulse store with promo code accordions, cart manipulation, and checkout forms. |
| **API Gateway** | `synthetic-beta-http-api` (`fkvvrndb17`) | HTTP API with JWT Authorizer, CORS enabled for Amplify origin, routing to `synthetic-beta-api`. |
| **Cognito** | `synthetic-beta-users` | User pool managing administrator and operator authentication. |
| **DynamoDB** | `SyntheticBetaState` | Single-table storage for `RUN#<id>`, `SESSION#<id>`, `EVENT#<ts>`, `METRICS`, and `REPORT`. |
| **Step Functions** | `synthetic-beta-run-orchestrator` | Distributed Map orchestrating 1 to 100 concurrent/batched sessions with error handling. |
| **Lambda (API)** | `synthetic-beta-api` | Ingests run plans, seeds populations, enforces origin allowlists, and handles read APIs. |
| **Lambda (Worker)** | `synthetic-beta-session-worker` | Assumes role into Agent Plane, drives browser session, runs Nova trace adapter, writes events. |
| **Lambda (Finalizer)**| `synthetic-beta-finalizer` | Triggered upon Step Functions run completion; computes deterministic metrics & writes report. |
| **S3 Storage** | `synthetic-beta-artifacts-20260919-k7m4q2` | Stores session payloads, event logs, checkpoint screenshots, and finalized JSON reports. |
| **AWS Budgets** | `SyntheticBetaSpendLimit` | $80 total hackathon budget with SNS notifications at 80% and 100% thresholds. |

### 2. Agent Execution Plane (Account `768669378827`)

| Service | Resource Name / ID | Configuration & Purpose |
| --- | --- | --- |
| **Bedrock AgentCore Browser**| `SyntheticBetaBrowser` (`aws.browser.v1`)| Sandboxed headless browser micro-VMs with server-side 180s/300s TTL. |
| **Browser Streams** | Automation (CDP) & Live View | Secure WebSocket for remote devtools protocol and WebRTC video stream for visual monitoring. |
| **Amazon Nova Act** | `synthetic-beta-browser-session` | Multimodal model `nova-act-v1.0` evaluating visual DOM state and executing natural browser actions. |
| **IAM Execution Role**| `SyntheticBetaAgentExecutionRole` | Cross-account role allowing browser session creation and Nova Act execution from Account `643700104680`. |
| **S3 Raw Trajectories**| `synthetic-beta-artifacts-vivek-20260919` | Raw agent logs, step traces, and CDP debug streams prior to event schema reduction. |

---

## Cross-Account IAM & Trust Boundaries

### Cross-Account Trust Policy (`SyntheticBetaAgentExecutionRole`)

Attached to Account `768669378827`, trusting the Control Plane Lambda in Account `643700104680`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrustControlPlaneWorker",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::643700104680:role/synthetic-beta-worker-execution-role"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "synthetic-beta-us-east-1-prod"
        }
      }
    }
  ]
}
```

### Role Permissions Policy

Restricted to minimal required actions on Bedrock AgentCore Browser, Nova Act, and trajectory S3 storage:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockAgentCoreBrowserManagement",
      "Effect": "Allow",
      "Action": [
        "bedrock:StartBrowserSession",
        "bedrock:StopBrowserSession",
        "bedrock:GetBrowserSession"
      ],
      "Resource": "arn:aws:bedrock:us-east-1:768669378827:browser/aws.browser.v1"
    },
    {
      "Sid": "AmazonNovaActExecution",
      "Effect": "Allow",
      "Action": [
        "nova-act:StartWorkflowExecution",
        "nova-act:GetWorkflowExecution",
        "nova-act:StopWorkflowExecution"
      ],
      "Resource": "arn:aws:nova-act:us-east-1:768669378827:workflow/synthetic-beta-browser-session"
    },
    {
      "Sid": "AgentTrajectoryPersistence",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::synthetic-beta-artifacts-vivek-20260919/nova-trajectories/*"
    }
  ]
}
```

---

## Target Data Flow & Orchestration

```text
Amplify Web SPA (643700104680)
      │
      ▼
API Gateway: fkvvrndb17
      │
      ▼
Lambda: synthetic-beta-api ──writes run/personas──► DynamoDB: SyntheticBetaState
      │
      ▼ (triggers execution)
Step Functions: synthetic-beta-run-orchestrator (Distributed Map)
      │
      ├── [Session 001..100 in batches of 10-20]
      ▼
Lambda: synthetic-beta-session-worker
      │
      ├── 1. AssumeRole -> Vivek Account (768669378827)
      ├── 2. StartBrowserSession(aws.browser.v1) -> CDP WebSocket + Live View URL
      ├── 3. Execute Nova Act Workflow (nova-act-v1.0) against authorized HTTPS target
      ├── 4. Raw trajectory saved to S3: synthetic-beta-artifacts-vivek-20260919
      ├── 5. Ingest raw steps via nova-trace-adapter.ts -> BehaviorEvent[]
      ├── 6. Write events & session state to DynamoDB: SyntheticBetaState
      └── 7. Write session log to S3: synthetic-beta-artifacts-20260919-k7m4q2
      │
      ▼ (all sessions complete)
Lambda: synthetic-beta-finalizer
      │
      ├── 1. Read all SessionRecords & BehaviorEvents from DynamoDB
      ├── 2. Pure function: computeRunMetrics(sessions, events)
      ├── 3. Assemble deterministic findings: buildSyntheticBetaReport(...)
      ├── 4. Write METRICS, FINDINGS, and REPORT items to DynamoDB
      └── 5. Upload reports/<runId>.json to S3 and generate presigned download URL
      │
      ▼
Amplify Frontend displays final report & visual funnels to operator
```

---

## Guardrails as Infrastructure Controls

| Guardrail | Infrastructure Enforcement Mechanism | Limit |
| --- | --- | ---: |
| **Global Spend Ceiling** | AWS Budgets with SNS alert topic + API admission check | **$80.00** |
| **Per-Run Hard Cap** | Pre-execution budget validation in `synthetic-beta-api` Lambda | **$40.00** |
| **Session Duration** | Bedrock AgentCore Browser session timeout + Lambda timeout | **180s (max 300s)** |
| **Batch Concurrency** | Step Functions Distributed Map `MaxConcurrency` setting | **10 - 20** |
| **Action Ceiling** | Nova Act `max_steps` parameter + state guardrail | **40 steps** |
| **Authorized Targets** | API domain validation + AgentCore outbound network boundary | **Public HTTPS only** |
| **Secret Redaction** | Lambda worker URL/event scrubber before DynamoDB persistence | **Zero credentials logged** |

