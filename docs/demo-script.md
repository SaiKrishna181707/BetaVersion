# Three-Minute Demo Script & Video Sequence

**Core Thesis**:  
> *"We don’t ask synthetic consumers what they think they’ll do. We watch what they actually do inside the product."*

The judge experience follows a tight, proof-oriented progression:  
**Define & Guardrail → Deploy to Cloud → Watch Live Autonomous Navigation → Trace Evidence → 100-User Scale Funnel & Report → Dual-Account Architecture Close**.

---

## Video Timeline (180 Seconds Total)

### 0:00–0:30 — Problem & Philosophy: Watching vs. Asking
- **Visual**: Title screen / Opening on host at the deployed Amplify web interface (`https://main.d1s2dm4wj8xxb.amplifyapp.com`).
- **Narrator**:
  > "Recruiting your first 100 beta users takes weeks, costs thousands of dollars, and burns through hard-won trust when obvious usability traps break your flow.
  > 
  > Most AI testing tools try to solve this with persona surveys — prompting an LLM to imagine how a user might feel.
  > 
  > At Synthetic Beta, we believe in a fundamentally different standard: **We don’t ask synthetic consumers what they think they’ll do. We watch what they actually do inside the product.**
  > 
  > Today, we're demonstrating autonomous synthetic users operating a real web product in real cloud browsers, with every single metric calculated directly from recorded behavioral evidence."
- **Clear Boundary**: Mention once: *"Synthetic users are simulated agents with distinct behavioral priors. They do not predict market demand or replace real human validation, but they catch friction before real users do."*

---

### 0:30–1:00 — Define the Run & Enforce Guardrails
- **Visual**: Operator fills out the **New Run** form on the live Amplify app.
  - Target URL: `https://main.d1s2dm4wj8xxb.amplifyapp.com/demo-target-checkout/` (ShopPulse E-Commerce)
  - Target Audience: *"Budget-conscious, mobile-first shoppers"*
  - Objective: *"Find an item, add it to your cart, proceed to checkout, and complete the order."*
  - Population: **100 Synthetic Users**
  - Concurrency: 5 batches of 20 users
  - Guardrails: Maximum session 180s, estimated cost $8.24, per-run hard cap $40.00, global AWS budget limit $80.00.
  - Check the authorization acknowledgment checkbox.
- **Narrator**:
  > "We configure a run against our authorized e-commerce product. Notice the built-in cost controls: a strict $40 per-run hard cap and an active $80 AWS Budget limit with SNS alerting.
  > 
  > When we click 'Start Run', our Control Plane in Account 643700104680 seeds a reproducible population across diverse technical abilities, patience levels, and reading styles, then dispatches the batch orchestrator."

---

### 1:00–1:45 — Live View: Nova Act Autonomous Browser Navigation
- **Visual**: Switch to the **Live Run** dashboard, then drill into an active session's **Bedrock AgentCore Live View Stream**.
  - Show the live video stream of a sandboxed headless Chromium instance.
  - Highlight the agent's cursor moving, clicking the "Add to Cart" button, opening the cart drawer, navigating to the checkout screen, and typing an email into the input field.
  - Show the agent encountering the "Promo Code" accordion, pausing to decide whether to search for a code, and either proceeding or backtracking.
- **Narrator**:
  > "Here is the core breakthrough: Amazon Bedrock AgentCore Browser streaming live via WebRTC from our Agent Plane in Account 768669378827.
  > 
  > This is not a recorded video or a hardcoded Selenium script. Amazon Nova Act is inspecting the live DOM and screenshot viewport over a WebSocket CDP automation stream.
  > 
  > This specific persona has low patience and category familiarity. Watch as it navigates directly to the cart and starts the checkout flow. When it hits our deliberate promo code hurdle, Nova Act evaluates the visible UI and decides autonomously whether to persist or abandon."

---

### 1:45–2:15 — Session Detail & Real Action Trace (Zero Hallucinations)
- **Visual**: Open the **Session Detail** view for the completed session.
  - Show the timeline of discrete actions: `NAVIGATE`, `CLICK #add-to-cart-btn`, `CLICK #proceed-checkout-btn`, `TYPE #email`, `SUBMIT #place-order-btn`.
  - Show the elapsed millisecond timestamps, agent reasoning thoughts, and screenshot artifacts.
- **Narrator**:
  > "Every move the agent makes is captured as an immutable raw trajectory in S3 and bridged by our Nova Trace Adapter into strictly typed behavior events in DynamoDB.
  > 
  > Notice the agent reasoning code: 'GOAL_PROGRESS', then 'EXPLORING', then 'OBJECTIVE_COMPLETE'. There is zero LLM math or hallucinated data here — if an action wasn't executed in Chromium, it does not exist in our database."

---

### 2:15–2:45 — Scale: 100-User Funnel & Drop-Off Friction Findings
- **Visual**: Navigate to the completed **100-User Run Report** (`run-mu8qcp85-ryxcm`).
  - Funnel Chart & Session Metrics: 100 sessions attempted, 100 terminal records, 0 throttled.
  - Friction Findings: 2 distinct friction findings identified by the deterministic analytics engine.
  - Show that every finding has clickable links directly to the supporting session IDs.
- **Narrator**:
  > "Here is the full 100-user population run, orchestrated across 20 controlled waves of 5 via Step Functions Distributed Map.
  > 
  > In minutes, without burning a single real customer relationship, we observe authentic user behavior:
  > 100 real sessions executed across our cross-account STS bridge with zero infrastructure throttling.
  > 
  > Our deterministic analytics engine calculated these numbers straight from the recorded browser events. Every finding links directly back to the session trace and event log that proved it."

---

### 2:45–3:00 — Dual-Account Architecture & Close
- **Visual**: Display the **Canonical Dual-Account Architecture Diagram** highlighting the Control Plane (643700104680) and Agent Plane (768669378827) with AWS Budgets & SNS controls.
- **Narrator**:
  > "Under the hood, Synthetic Beta enforces strict dual-account security: our client control plane in Account 643700104680 never exposes customer data to untrusted sites, while Bedrock AgentCore and Nova Act run in our hardened Agent Execution Plane in Account 768669378827, bounded by a $45 run cap and an $80 account ceiling.
  > 
  > Don’t guess what your users will do. Watch them before you launch. That is Synthetic Beta. Thank you."

---

## Production Demo Checklist

- [x] Amplify production build deployed from `main` at `https://main.d1s2dm4wj8xxb.amplifyapp.com`
- [x] Embedded demo targets accessible (`/demo-target/` and `/demo-target-checkout/`)
- [x] Live View WebRTC streaming endpoint verified in AgentCore Browser
- [x] Step-by-step action/event timeline verified in Session Detail page
- [x] Preserved 100-user clean run (`run-mu8qcp85-ryxcm`) loaded with full funnel and friction findings
- [x] Dual-account architecture slide ready for closing

