# Centopus documentation

This folder contains both judge-facing technical documentation and internal/supporting material used while building and preparing the hackathon submission.

## Judge-facing technical docs

These are the only supporting documents a reviewer should need after the main README:

- [Architecture and storage contract](architecture.md) — system boundaries, storage model, orchestration, and failure behavior.
- [AWS execution and evidence](aws-execution.md) — how Nova Act, AgentCore Browser, session workers, and evidence recording work.
- [Cost model](cost-model.md) — run-estimate inputs, spend guardrails, concurrency, and budget controls.

## Developer / audit docs

Useful for implementation review and maintenance, but not required reading for judges:

- [Integration audit](integration-audit.md)
- [Final deployment / verification report](final-deployment-report.md)
- [Local session notes](l1-local-session.md)

## Submission-preparation material

Kept for team reference and reproducibility of the final submission process:

- [Judge-ready 3-minute demo script](JUDGE_READY_3_MINUTE_DEMO_SCRIPT.md)
- [Demo script](demo-script.md)
- [Narration timing data](demo-narration-segments.json)
- [Submission checklist](submission-checklist.md)
- [Submission packet](submission-packet.md)

The main project story, demo link, AWS architecture, setup instructions, team contributions, and responsible-use statement live in the repository root [README](../README.md).
