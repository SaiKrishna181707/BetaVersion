# Three-minute demo script

The judge experience is **define → deploy → watch → evidence → report**. Do not spend the video explaining
repository structure.

## 0:00–0:25 — Problem

> Beta cohorts are expensive and slow to recruit. Synthetic Beta gives a web product its first behavioral test
> before real users are spent: autonomous synthetic users actually use the product, and every metric is tied
> back to recorded evidence.

State the boundary once: synthetic users are simulated agents, not replacements for real-user validation.

## 0:25–0:50 — Define the run

Open the hosted Synthetic Beta frontend.

Show:

- authorized staging URL,
- target audience,
- one concrete objective,
- population size,
- session/batch limits,
- estimated cost and hard cap,
- authorization acknowledgement.

Do not demo every validation error. One quick guardrail is enough.

## 0:50–1:25 — Prove the agent is real

Start or show a small AWS run.

Open Amazon Bedrock AgentCore Browser **Live View** for one active synthetic user and show it making its own
navigation decisions. The key visual is that the agent is operating the real site, not printing a survey answer.

Say:

> This user has a persona and an objective. It is not following a Selenium click script; Nova Act is deciding how
> to operate the product in an isolated AgentCore browser.

If a live run is risky during recording, start it before the recording and cut to the already-active Live View.

## 1:25–1:45 — Scale

Show the run dashboard or stored completed run:

```text
Synthetic users     100
Completed             …
Abandoned             …
Technical failures    …
Median time-to-value  …
```

The final demo run can be five controlled batches of 20. "100 synthetic users" describes the tested
population, not simultaneous browser startup.

## 1:45–2:20 — Evidence

Open the largest friction point, then one supporting session.

Show:

- the action/session identifier,
- where the user stopped or retried,
- screenshot/recording evidence,
- the corresponding funnel/friction metric.

Emphasize that the metric is computed in code from evidence; the agent/model did not calculate the percentage.

## 2:20–2:45 — Report

Show the final Synthetic Beta report:

- objective completion,
- largest funnel drop,
- technical failures,
- friction/retries,
- cohort differences,
- limitations.

A finding should link back to real session evidence.

## 2:45–3:00 — AWS / close

Show one architecture frame:

```text
Amplify → control plane → Nova Act → AgentCore Browser
                             ↓
                        evidence
                             ↓
                    deterministic analytics
```

Close:

> Synthetic Beta does not predict whether a startup will win. It shows where autonomous users actually struggled
> before you recruit your real beta cohort.

## Pre-recording release gate

Do not record the final demo until:

- CI is green,
- the deployed frontend is from `main`,
- one real Nova Act + AgentCore Browser run has been captured,
- the demo uses only owned/authorized targets,
- the 100-user result shown in the video came from actual executed sessions,
- any feature not working is removed from the demo rather than described as if it worked.

For local fallback only, `npm run l1:run` still proves the event/analytics pipeline, but it must not be presented
as the AWS execution path.
