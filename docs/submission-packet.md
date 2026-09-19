# Synthetic Beta — Official Hackathon Submission Packet

---

## 1. Submission Overview

- **Project Title**: Synthetic Beta
- **One-Line Tagline**: Before you recruit your first 100 beta users, deploy up to 100 synthetic users and watch where your product breaks.
- **Production URL**: [https://main.d1s2dm4wj8xxb.amplifyapp.com](https://main.d1s2dm4wj8xxb.amplifyapp.com)
- **API Gateway Endpoint**: `https://fkvvrndb17.execute-api.us-east-1.amazonaws.com`
- **Target AWS Region**: `us-east-1` (US East, N. Virginia)

---

## 2. Detailed Project Description

### The Problem
Recruiting an initial beta cohort of 50 to 100 real users is slow, expensive, and risky. Early-stage product teams often spend weeks recruiting beta testers, only for those users to get stuck on confusing navigation, broken form validation, or hidden call-to-action buttons within their first three minutes. Once a real user experiences friction and abandons the product, their trust is burned and their feedback is lost.

Existing "AI user testing" solutions attempt to solve this by surveying large language models: asking an LLM to roleplay a user persona and predict how they would evaluate a landing page. But **asking an LLM what a consumer might do produces plausible-sounding survey opinions, not behavioral reality**. Text simulations do not click buttons, trigger browser reflows, encounter race conditions, or get confused by subtle visual layout shifts.

### The Solution: Behavioral Observation
Synthetic Beta introduces a fundamentally different standard:  
> *"We don’t ask synthetic consumers what they think they’ll do. We watch what they actually do inside the product."*

Synthetic Beta deploys autonomous synthetic users into sandboxed cloud browsers to use the real product. Each synthetic user is initialized with a structured behavioral persona (varying across technical proficiency, product familiarity, patience levels, reading styles, and price/privacy sensitivity) and a single task objective (e.g., *"Find an item, add to cart, and complete order"*). 

The platform lets agents navigate freely in real browser sessions, records every discrete browser interaction, passes raw trajectories through a zero-hallucination trace adapter, computes deterministic behavioral analytics, and compiles an evidence-grounded report highlighting exact drop-off bottlenecks.

### Canonical Dual-Account Architecture
To guarantee absolute security and isolate client data from untrusted web targets, Synthetic Beta operates across two dedicated AWS accounts:
1. **Control Plane — Kittu Account (`643700104680`)**:
   - **AWS Amplify Hosting**: Serves the operator frontend SPA and embedded test targets.
   - **Embedded Demo Targets**:
     - *Demo Target 1 (Fieldwork SaaS)*: `/demo-target/` — Project collaboration tool with discoverability traps and layout shifts.
     - *Demo Target 2 (ShopPulse E-Commerce)*: `/demo-target-checkout/` — E-commerce store testing cart interactions and promo code hurdles.
   - **Amazon API Gateway & Lambda**: HTTP API `fkvvrndb17` routing to `synthetic-beta-api` for plan validation and population seeding.
   - **Amazon Cognito**: User Pool `synthetic-beta-users` for secure operator authentication.
   - **Amazon DynamoDB**: `SyntheticBetaState` single-table schema storing runs, sessions, events, and reports with automated 7-day TTL.
   - **AWS Step Functions**: `synthetic-beta-run-orchestrator` managing Distributed Map batch concurrency across sessions.
   - **Amazon S3**: `synthetic-beta-artifacts-20260919-k7m4q2` for session logs and reports.
   - **AWS Budgets & SNS**: $80 account ceiling, $40 per-run hard cap with automated SNS alerting.

2. **Agent Execution Plane — Vivek Account (`768669378827`)**:
   - **Amazon Bedrock AgentCore Browser**: Managed headless Chromium instances (`SyntheticBetaBrowser` / `aws.browser.v1`) running in isolated Firecracker micro-VMs.
   - **Interactive Streams**:
     - *WebSocket Automation Stream (CDP)*: Direct DevTools protocol automation for Nova Act.
     - *WebRTC Live View Stream*: Real-time video stream rendered in the operator frontend.
   - **Amazon Nova Act**: Multimodal foundation model (`nova-act-v1.0`, workflow `synthetic-beta-browser-session`) executing autonomous actions based on persona traits and objectives.
   - **Cross-Account IAM Role**: `SyntheticBetaAgentExecutionRole` assumed by the Control Plane session worker via STS.
   - **Amazon S3 Trajectories**: `synthetic-beta-artifacts-vivek-20260919` storing raw agent logs and CDP streams.

### Trace Adapter & Deterministic Analytics
Synthetic Beta separates autonomous reasoning from numerical calculation:
- **Zero-Hallucination Adapter (`nova-trace-adapter.ts`)**: Ingests raw Nova Act steps and converts them directly into strict `BehaviorEvent[]` records. If an action did not occur in the browser, no event is created.
- **Deterministic Analytics Engine (`@synthetic-beta/analytics`)**: Pure mathematical reduction over recorded events computing completion rates, funnel drop-offs, retry friction counts, and median time-to-value. Rates preserve explicit numerators and denominators (`supporting_session_ids`), ensuring total transparency.

---

## 3. Built With

- **Amazon Nova Act**: Multimodal agent model (`nova-act-v1.0`) driving autonomous visual browser navigation without pre-recorded scripts.
- **Amazon Bedrock AgentCore**: Managed browser runtime (`aws.browser.v1`) providing secure micro-VM Chromium instances, CDP WebSocket automation streams, and WebRTC Live View streams.
- **AWS Step Functions**: Distributed Map state machine orchestrating controlled batch execution (5 batches of 20 users) up to 100 concurrent/batched sessions.
- **AWS Lambda**: Serverless execution handlers for API dispatch, cross-account session execution, and deterministic metric finalization.
- **Amazon DynamoDB**: Single-table data store indexing runs, sessions, events, metrics, and findings with automated 7-day TTL.
- **Amazon S3**: Artifact persistence for structured session logs, raw agent trajectories, checkpoint screenshots, and downloadable report packages.
- **Amazon API Gateway**: HTTP API with CORS configuration and JWT authorization.
- **Amazon Cognito**: User Pool managing operator authentication.
- **AWS Amplify**: Continuous delivery and static web hosting for the Vite/React frontend and embedded demo targets.
- **Amazon CloudWatch**: Detailed Lambda and Step Functions execution logs, metrics, and error tracking.
- **Amazon ECR**: Container image storage for custom worker runtimes.
- **TypeScript**: Shared contracts, validation schemas, frontend UI, Lambda handlers, and deterministic analytics engine.
- **React**: Modern dashboard providing run configuration, real-time Live View video inspection, session step inspector, and funnel visualizers.
- **Python**: Headless Nova Act worker and Bedrock AgentCore Browser automation client with full contract and adversarial test suites.

---

## 4. Limitations & Guardrails

### Simulated Agent Behavior Limitations
- **Behavioral Signal, Not Market Validation**: Synthetic Beta measures usability, discoverability, navigation friction, and technical hurdles. It does **not** predict commercial willingness-to-pay, product-market fit, or virality.
- **Heuristic Priors**: Personas embody simulated behavior distributions (e.g., low-patience users give up quickly; scanning readers miss secondary buttons). While grounded in UX research, they are models, not real humans.
- **Pre-Beta Focus**: Designed to catch obvious usability and flow defects *before* inviting real human cohorts, preserving user trust.

### Safety & Operational Guardrails
- **Explicit Authorization Only**: Runs are restricted to domains owned or explicitly authorized by the operator.
- **Public HTTPS Targets Only**: Targets must use valid HTTPS. Private network ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), local loopbacks (`127.0.0.1`, `localhost`), and cloud metadata IP (`169.254.169.254`) are strictly blocked before browser initialization.
- **Zero Destructive Actions**: Prompt-level and runtime guardrails strictly prohibit real-money purchases, account deletions, third-party messaging/spam, credential stuffing, and CAPTCHA bypass.
- **Secret Redaction**: Query parameters, passwords, and sensitive tokens are automatically redacted prior to database persistence.

---

## 5. Cost & Spend Control Governance

Synthetic Beta is engineered with multiple concentric layers of cost protection to prevent unexpected cloud spend:
- **$40.00 Per-Run Hard Cap**: Every run configuration is evaluated by the cost estimation engine before execution. If the estimated cost exceeds $40.00 (or if the user sets a lower cap), the run is rejected at API admission.
- **$80.00 Global AWS Budget Limit**: An active AWS Budget tracks cumulative expenditure across both AWS accounts, configured with Amazon SNS topic notifications at 80% and 100% thresholds.
- **Bounded Session Ceilings**:
  - Default session timeout: 180 seconds.
  - Server-side hard timeout: 300 seconds enforced by AgentCore Browser.
  - Maximum action ceiling: 40 discrete steps enforced by Nova Act state guardrails.
- **Cost Efficiency**: A full 100-user batch run against the ShopPulse checkout flow executed for only **$8.24**, far below the $40.00 cap.

---

## 6. Complete Submission Form Answers

### Elevator Pitch
> Before you recruit your first 100 beta users, deploy up to 100 autonomous synthetic users powered by Amazon Nova Act and Amazon Bedrock AgentCore Browser to watch exactly where your web product breaks.

### What It Does
Synthetic Beta automates early behavioral usability testing for web products. Instead of relying on static persona surveys, the platform seeds a diverse cohort of up to 100 synthetic users with varying patience levels, technical abilities, and reading styles. Each synthetic user navigates the real product in a sandboxed Amazon Bedrock AgentCore browser guided by Amazon Nova Act. 

Operators can watch the agents navigate in real-time via WebRTC Live View streams, inspect step-by-step action traces, and view deterministic funnel analytics and drop-off reports computed directly from recorded browser evidence.

### How We Built It
We implemented a canonical dual-account AWS architecture:
1. **Control Plane (Account `643700104680`)**: Built with AWS Amplify Hosting (React/TypeScript SPA), Amazon API Gateway, AWS Lambda, Amazon DynamoDB (single-table schema), and AWS Step Functions (Distributed Map).
2. **Agent Execution Plane (Account `768669378827`)**: Built with Amazon Bedrock AgentCore Browser (sandboxed headless Chromium micro-VMs), Amazon Nova Act (multimodal reasoning workflow), and real-time WebSocket CDP and WebRTC Live View streaming.
3. **Trace Adapter & Analytics**: A zero-hallucination TypeScript adapter (`nova-trace-adapter.ts`) that maps raw Nova Act steps into strict `BehaviorEvent[]` records, processed by a pure-function deterministic analytics engine (`@synthetic-beta/analytics`).

### Challenges We Ran Into
1. **Cross-Account Streaming & Security**: Securely bridging live browser CDP sockets and WebRTC video streams across two isolated AWS accounts required strict IAM trust policies with `sts:ExternalId` verification.
2. **Zero-Hallucination Telemetry**: Ensuring LLM agents never hallucinate percentages or metrics required establishing a hard architectural boundary: Nova Act makes browser decisions, while deterministic TypeScript code computes all funnel metrics and drop-off rates from recorded event logs.
3. **Graceful Quota & Browser Lifecycle Management**: Managing browser sessions across 100 synthetic users required configuring Step Functions Distributed Map concurrency limits (`MaxConcurrency: 20`) to prevent API throttling while preserving low median time-to-value.

### Accomplishments We're Proud Of
- **Real Autonomous Navigation**: Nova Act successfully navigates real web applications, clicks buttons, types in forms, and overcomes intentional UX traps without requiring synthetic test checkpoint hooks.
- **WebRTC Live View Integration**: Streaming live agent browser interactions directly into the React frontend in real-time.
- **Full 100-User Concurrency Run**: Successfully executed 100 synthetic sessions across 5 batches of 20, recording 584 discrete actions and identifying exact checkout drop-off bottlenecks for only $8.24 in cloud compute.
- **Rigorous Engineering Standards**: 124 passing unit/integration/stress tests, CI-automated dependency auditing, and strict dual-account least-privilege security.

### What We Learned
- Multimodal agents like Nova Act excel at interpreting real visual UI hierarchy, distinguishing primary calls-to-action from secondary links naturally.
- Autonomous browser testing requires hard server-side timeouts and observation ceilings; prompt instructions alone are not enough for reliable spend control.
- Deterministic metric reduction over recorded event traces builds far higher trust with product managers than generative LLM summaries.

### What's Next for Synthetic Beta
- **Multi-Tab & OAuth Flow Testing**: Extending Bedrock AgentCore Browser sessions to handle external social logins and multi-window authentication.
- **A/B Testing Comparison Runs**: Allowing teams to deploy 50 synthetic users to Variant A and 50 to Variant B simultaneously to compare funnel conversion rates with statistical confidence intervals.
- **Automatic Fix Suggestions**: Integrating Bedrock reasoning models to suggest specific CSS/DOM fixes for detected friction points.

---

## 7. Resource & Endpoint Directory

| Resource | Value / URI |
| --- | --- |
| **Amplify Web Application** | [https://main.d1s2dm4wj8xxb.amplifyapp.com](https://main.d1s2dm4wj8xxb.amplifyapp.com) |
| **Demo Target 1 (Fieldwork)** | [https://main.d1s2dm4wj8xxb.amplifyapp.com/demo-target/](https://main.d1s2dm4wj8xxb.amplifyapp.com/demo-target/) |
| **Demo Target 2 (ShopPulse)** | [https://main.d1s2dm4wj8xxb.amplifyapp.com/demo-target-checkout/](https://main.d1s2dm4wj8xxb.amplifyapp.com/demo-target-checkout/) |
| **API Gateway Invoke URL** | `https://fkvvrndb17.execute-api.us-east-1.amazonaws.com` |
| **Control Plane AWS Account** | `643700104680` (Kittu Account) |
| **Agent Plane AWS Account** | `768669378827` (Vivek Account) |
| **Bedrock Browser Identifier**| `SyntheticBetaBrowser` (`aws.browser.v1`) |
| **Nova Act Workflow** | `synthetic-beta-browser-session` (model: `nova-act-v1.0`) |
| **State Machine ARN** | `arn:aws:states:us-east-1:643700104680:stateMachine:synthetic-beta-run-orchestrator` |
| **DynamoDB State Table** | `SyntheticBetaState` |
| **Control Artifacts Bucket** | `synthetic-beta-artifacts-20260919-k7m4q2` |
| **Agent Trajectory Bucket** | `synthetic-beta-artifacts-vivek-20260919` |
