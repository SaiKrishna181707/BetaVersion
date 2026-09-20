# Centopus submission packet

**Project:** Centopus
**Repository:** SaiKrishna181707/BetaVersion
**Description:** Synthetic usability sessions that turn observed browser actions into evidence-linked product findings.

An operator describes an authorized product, creates and edits a synthetic population, and starts independent browser sessions with bounded time, actions, parallelism and estimated spend. React displays persisted session states, actions and deterministic reports. Product intelligence uses Gemini; browser execution uses Nova Act connected to AgentCore Browser.

The control and agent planes use separately configured AWS accounts. CDK backend definitions, explicit Lambda bundles, an Amplify build configuration, SDK checks and offline contract tests are included. This source tree is not proof of a current deployment.

Metrics are computed from recorded sessions/events. A final LLM response never becomes an event or proof of success. Verified completion requires a configured DOM checkpoint. Generic sites can yield action/friction evidence while completion stays unverified. Actual billing and Live View/WebRTC are not integrated.

Configuration supports up to 100 sessions in batches of at most five. No fresh load-test result or production availability is asserted. Synthetic agents provide an early usability signal, not market validation or a substitute for real people.

Before submission, complete the [checklist](submission-checklist.md), attach current run evidence and a demo from the tested commit, and verify deployment URLs. Historical performance claims are not current release verification.
