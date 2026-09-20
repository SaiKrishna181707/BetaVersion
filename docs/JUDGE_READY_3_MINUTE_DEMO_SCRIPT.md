# Centopus — three-minute demo narration

## 0:00–0:20 — The problem

Product teams do not need another dashboard that tells them what happened after launch. They need to know where real journeys will break before customers find the problem. Centopus turns one product URL and one customer task into a population-scale usability simulation.

## 0:20–0:45 — Start with the real product

Here I enter Apple and its public website. Centopus researches the product context, then gives me an editable test plan. Our task is deliberately safe and measurable: find iPhone, compare the latest models, and reach the purchase configuration page without placing an order.

## 0:45–1:10 — Build the population

I set the population to one hundred agents. Each agent has a distinct profile—different devices, technical confidence, patience, reading style, motivations, and abandonment triggers. This is not one happy-path browser test copied a hundred times. It is a reproducible population designed to expose where different users diverge.

## 1:10–1:35 — Nova-powered execution

Centopus uses Amazon Nova for product and persona intelligence, and the production execution path uses Nova Act to operate the browser within strict limits. Every run is bounded by an authorized domain, an action ceiling, a time ceiling, concurrency controls, and a hard budget. Agents can observe, reason, act, and stop—but they cannot leave the approved target or cross a purchase boundary.

## 1:35–1:55 — Evidence, not vibes

As the simulation runs, Centopus records each agent separately. Status, action count, stop reason, and browser evidence remain tied to that individual session. A completion claim only counts when the browser observation supports it. Model prose alone is never treated as proof.

## 1:55–2:30 — Read the result

Now the report turns one hundred journeys into a decision. In this deterministic demonstration, seventy-six agents are positive, twenty are mixed, and four are negative. The distribution is instantly readable, but the aggregate is only the starting point. I can filter the four negative experiences, open an individual journey, and see the exact friction that changed that agent’s outcome.

## 2:30–2:50 — From signal to action

The feedback view uses Nova to synthesize repeated evidence into positive signals, mixed signals, negative signals, and one prioritized recommendation. That gives a product team a concrete next move while preserving the underlying sessions for review.

## 2:50–3:00 — Close

For a repeatable three-minute demonstration, this recording uses a deterministic result fixture; production runs use the live Nova Act execution path. Centopus helps teams test with a hundred perspectives before they ship to millions.
