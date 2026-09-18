# Demo script

The judge experience is **create → watch → inspect → replay → report**. This script is honest about which step
is live today and which arrives with the execution phase, so nothing on screen has to be walked back.

## Prerequisite

Two terminals:

```bash
npm install
npm run dev:demo   # authorized demo target on http://127.0.0.1:4174
npm run dev        # workspace on http://127.0.0.1:5173
```

## 1. Frame the problem (30 seconds)

> Recruiting 100 beta users is slow and expensive, and by the time feedback arrives you have already burned the
> cohort. Synthetic Beta deploys synthetic users first, so you find the obvious breakage before you spend the
> real audience.

State the boundary plainly: these are simulated agents, not real people, and they run only against a product
you are authorized to test.

## 2. Define the run — **live today**

On the landing page, point out that the headline is the claim and the session observer is labelled
`ILLUSTRATIVE PREVIEW`. It is a design fixture, not recorded activity.

Open **New run** (`#/new`) and fill the form against the demo target:

- Target URL: `http://localhost:4174` (the suggested placeholder)
- Product description: a project tool for small teams
- Target audience: early-stage founders trying a project tool for the first time
- One objective: *Create a project and invite a teammate to collaborate.*
- Synthetic users: 1, then show the ladder to 5, 20, 100

Then demonstrate the guardrails rather than describing them:

- Paste `http://localhost:4174/?session=abc` and show that query parameters are rejected.
- Paste `https://example.com` and show that an unauthorized host is rejected.
- Set the hard budget cap to `0.50` and show the estimate exceed the cap.
- Clear the authorization checkbox and show that review is blocked.

Open **How this estimate works** in the cost panel. Every rate shown is read from the dated cost model, and the
arithmetic is in `docs/cost-model.md`. Then press **Review run** and save the draft — the disclosure states that
no browser starts and no AWS charges are incurred.

## 3. Population — **next phase**

The cohort is already computed deterministically today: `POST /runs/:id/population-preview` returns seeded
personas and a trait profile, covered by tests. The screen that renders it is registered in the route table as
`PLANNED`, so visiting `#/runs/example/population` shows an honest placeholder instead of a fabricated table.

## 4. Watch, inspect, replay — **live locally, not on AWS**

Starting a run through the API returns `501 EXECUTION_NOT_CONFIGURED` by design. The browser session itself can
be demonstrated today with a local adapter: keep `npm run dev:demo` running and use a second terminal.

```bash
npm run l1:run                 # one persona, headless
L1_HEADLESS=0 npm run l1:run   # same session in a visible window
```

The runner prints the persona, the objective, the outcome, the actions taken, the checkpoints reached, and the
deterministic metrics computed from the log, then names the session directory it wrote under `.artifacts/`.
Open `events.json` beside the screenshots to walk a judge through "what did this synthetic user actually do".
Say plainly that this is a local adapter: no Step Functions, no AgentCore Browser, no AWS spend.

The demo target already contains the friction these steps surface, and `demo-target/README.md` documents each
trap:

- The invite control is hidden behind the project overflow menu, not the Team tab.
- The invite form clears the email field when it fails validation.
- The members list loads slowly, pushing the invite control down the page.

Planned sequence once the AWS executor lands: watch sessions advance state by state on the Live Run screen, open
the session that hit the retry trap, and replay its recorded actions with screenshots beside the timeline. The
event log and the screenshots the replay needs already come out of L1.

## 5. Report — **next phase**

`buildSyntheticBetaReport` already produces findings from metrics with evidence pointers, and its output is
covered by tests. The narrative stays `null` unless a narrator is configured, so the report can be shown with
its interpretation layer switched off. The Run Report screen is registered as `PLANNED`.

## 6. Close on the guarantee (30 seconds)

The strongest claim is the one that can be checked:

- Every rate carries its numerator, denominator, and the session ids behind it.
- An empty denominator reports `null`, never `0%`.
- A report states how many session records and events it was computed from.
- The cost panel reads its rates from the same model the arithmetic uses.
- Unbuilt surfaces say so, and the unavailable executor throws instead of inventing behaviour.

Point at `npm test`: 98 tests, no network, no AWS, and the numbers in this script are asserted in them.

## Recovery notes

- **Port 4174 already in use**: stop the other process, or edit the target URL — `demo-target/serve.mjs` takes
  a `PORT` environment variable.
- **Nothing renders at `#/new`**: the front end is hash-routed; confirm the URL ends in `#/new`.
- **Draft looks stale**: the New Run page warns when a saved draft is restored, and Reset form clears it.