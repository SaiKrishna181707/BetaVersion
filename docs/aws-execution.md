# AWS Execution & Dual-Account Orchestration

Synthetic Beta's cloud execution relies on a canonical **dual-account architecture** to strictly isolate operator workflows and client data from the sandboxed environment where autonomous agents interact with external web applications.

---

## 1. Dual-Account Topology

### Control Plane: Kittu Account (`643700104680`)
- **AWS Amplify Hosting**: Serves the operator web interface at [https://main.d1s2dm4wj8xxb.amplifyapp.com](https://main.d1s2dm4wj8xxb.amplifyapp.com) and two embedded test applications:
  - Demo Target 1 (Fieldwork SaaS): `/demo-target/`
  - Demo Target 2 (ShopPulse Checkout): `/demo-target-checkout/`
- **Amazon API Gateway**: HTTP API `synthetic-beta-http-api` (`fkvvrndb17.execute-api.us-east-1.amazonaws.com`).
- **Amazon Cognito**: User Pool `synthetic-beta-users` for operator authentication.
- **Amazon DynamoDB**: `SyntheticBetaState` single-table schema for run plans, personas, session metadata, event streams, and deterministic reports.
- **AWS Step Functions**: `synthetic-beta-run-orchestrator` managing Distributed Map batch concurrency across sessions.
- **AWS Lambda**:
  - `synthetic-beta-api`: Ingests run configurations, validates origins and budgets, seeds populations.
  - `synthetic-beta-session-worker`: Assumes cross-account role, launches browser session, runs Nova trace adapter, persists events.
  - `synthetic-beta-finalizer`: Executes deterministic analytics reduction on completed run sessions.
- **Amazon S3**: `synthetic-beta-artifacts-20260919-k7m4q2` for session logs, reports, and screenshots.
- **AWS Budgets & SNS**: $80 account ceiling, $40 per-run hard cap with automated SNS alerting.

### Agent Execution Plane: Vivek Account (`768669378827`)
- **Amazon Bedrock AgentCore Browser**: Ephemeral headless Chromium instances (`SyntheticBetaBrowser` / `aws.browser.v1`) running in isolated micro-VMs.
- **Real-Time Interactive Streams**:
  - **WebSocket Automation Stream (CDP)**: Secure communication channel for Nova Act to send mouse/keyboard events and inspect DOM nodes.
  - **WebRTC Live View Stream**: Real-time video stream rendered directly in the operator dashboard for live session monitoring.
- **Amazon Nova Act**: Multimodal foundation model (`nova-act-v1.0`, workflow `synthetic-beta-browser-session`) executing autonomous actions based on persona traits and objectives.
- **Cross-Account Assumed Role**: `SyntheticBetaAgentExecutionRole` with scoped trust policy allowing session worker Lambda in Account `643700104680` to manage browser sessions.
- **Amazon S3 Trajectories**: `synthetic-beta-artifacts-vivek-20260919` storing raw Nova Act step trajectories, CDP dumps, and execution logs.

---

## 2. Cross-Account Execution Workflow

```text
[Control Plane: synthetic-beta-session-worker]
                    │
                    │ 1. sts:AssumeRole(arn:aws:iam::768669378827:role/SyntheticBetaAgentExecutionRole)
                    ▼
[Agent Plane: Bedrock AgentCore Browser Client]
                    │
                    │ 2. StartBrowserSession(identifier="aws.browser.v1", timeout=180s)
                    ▼
   Returns CDP WebSocket URL + WebRTC Live View Stream URL
                    │
                    │ 3. Pass Live View URL to DynamoDB -> rendered in Amplify Web UI
                    ▼
[Agent Plane: Amazon Nova Act]
                    │
                    │ 4. Connect to CDP WebSocket
                    │ 5. Evaluate page screenshot & DOM accessibility tree
                    │ 6. Issue autonomous actions (navigate, click, type, submit, wait, abandon)
                    │ 7. Save raw trajectory to S3: synthetic-beta-artifacts-vivek-20260919
                    ▼
[Control Plane: nova-trace-adapter.ts]
                    │
                    │ 8. Ingest raw steps -> convert to strict BehaviorEvent[]
                    │ 9. Write events & session status to DynamoDB: SyntheticBetaState
                    ▼
[Control Plane: synthetic-beta-finalizer]
                    │
                    │ 10. Triggered upon Map completion -> computeRunMetrics & build report
```

---

## 3. Real AWS Worker Implementation

### Python Standalone Worker (`services/nova-worker/worker.py`)
For headless CI testing and standalone session execution:
- Accepts a JSON `SessionPlan`.
- Connects directly to Bedrock AgentCore Browser via AWS IAM credentials.
- Binds Nova Act to the CDP endpoint.
- Applies strict state guardrails: rejects navigation outside pre-approved `allowed_origins` and enforces maximum observation ceilings.

Validate a session plan without cloud spend:
```bash
python services/nova-worker/worker.py \
  --plan-file services/nova-worker/plan.example.json \
  --validate-only
```

Execute a single real session against an authorized HTTPS target:
```bash
export AWS_REGION=us-east-1
export NOVA_ACT_WORKFLOW_NAME=synthetic-beta-browser-session
export NOVA_ACT_MODEL_ID=nova-act-v1.0

python services/nova-worker/worker.py --plan-file /path/to/session-plan.json
```

### TypeScript Cloud Worker (`services/agent-worker/src/worker-lambda.ts`)
The serverless production path executed by Step Functions:
- Assumes the cross-account role in Account `768669378827`.
- Initiates the Bedrock AgentCore Browser session.
- Captures the Live View stream endpoint for immediate web UI inspection.
- Executes the Nova Act agent trajectory.
- Invokes `adaptNovaTraceToBehaviorEvents()` to write zero-hallucination `BehaviorEvent` records to DynamoDB.

---

## 4. Scale Path: 1 → 5 → 20 → 100 Users

Synthetic Beta promises evaluation of up to 100 synthetic users. The Step Functions Distributed Map orchestrates this scale safely:
1. **L2 (1 user)**: Single Nova Act session validating DOM interaction and Live View streaming.
2. **L3 (5 users)**: Small batch verifying parallel session isolation and DynamoDB event indexing.
3. **L4 (20 users)**: Full single-batch concurrency saturation test (`MaxConcurrency: 20`).
4. **L5 (100 users)**: Complete production run executed across 5 controlled batches of 20 users.

The 100-user run preserves all 500+ discrete behavior events, generating complete funnel drops, friction heatmaps, and cohort variance analytics.

---

## 5. Security & Spend Boundaries

- **Origin Whitelist**: Targets must be public HTTPS and explicitly enumerated in `allowed_origins`.
- **No Local/Private Targets**: `127.0.0.1`, `localhost`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `169.254.169.254` are blocked before browser initialization.
- **Spend Ceilings**:
  - Global AWS Budget: $80.00 hard limit with SNS alerting.
  - Per-Run Hard Cap: $40.00 admission check.
  - Session Duration: 180s default, 300s hard server-side timeout.
- **No Destructive Actions**: Prompt-level and state guardrails forbid real-money purchases, account deletions, spam, or CAPTCHA bypass.
