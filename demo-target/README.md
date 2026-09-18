# Demo target: Fieldwork

An authorized, local, disposable web product used as the test target for Synthetic Beta. It is intentionally
imperfect, and it makes **no external requests** — there is no fetch, no XHR, no remote asset, and no real data.
Everything lives in this browser's `localStorage`.

```bash
npm run dev:demo   # http://127.0.0.1:4174
```

Port 4174 is the URL the New Run form suggests, so `http://localhost:4174` passes the local-sandbox rule in
`validateRunConfiguration` without editing anything.

## Disposable sandbox account

Not a secret, and not usable anywhere else:

```
tester@sandbox.test / sandbox
```

## The objective it is built for

> Create a project and invite a teammate to collaborate.

## Deliberate friction

These traps exist so a synthetic session has something real to fail against. Each one is a plausible mistake a
real product team makes.

| # | Friction | Where |
| --- | --- | --- |
| 1 | **Discoverability trap.** The invite action is not in the Team tab. It is behind the project overflow menu (`...` in the project header). The Team tab shows members and the aside "Only project owners can invite people", which reads like a dead end. | Team tab, project header |
| 2 | **Slow list that shifts layout.** The member list resolves after 1.2 s and renders two skeleton rows first, so the page height changes while a session is reading it. | Team tab |
| 3 | **Retry trap.** The invite form validates 0.9 s after submit, and on failure it clears the email field. A session that retries without re-typing submits an empty field and fails again. | Invite panel |

A session can therefore plausibly: sign in, create a project, look for the invite action in the Team tab, not
find it, retry there, open the overflow menu by accident, recover, and either succeed at the invite or
accumulate repeated empty-field submissions until its retry or action budget runs out.

## Instrumentation hooks

Interactive elements carry stable `data-synthetic-target` attributes (`sign-in-form`, `new-project`,
`project-name`, `create-project-submit`, `open-project`, `project-overflow`, `invite-teammate`, `invite-email`,
`invite-submit`, `tab-team`, and so on). Recording tooling can use these as `target_descriptor` values instead
of guessing from visible text, which keeps an action log readable and comparable across sessions.

## Safety properties

- No purchases, no payment surface, no destructive action. Delete is rendered disabled and does nothing.
- No third-party content, no CAPTCHA, no analytics, no external network calls.
- Authentication is a single documented disposable account. It is not a real credential and grants nothing.
- `serve.mjs` resolves every request path against `demo-target/public` and refuses anything that escapes it.

## Resetting

Sign out, or clear `fieldwork:state:v1` from `localStorage`. `GET /reset` is deliberately not implemented: the
target must never expose an unauthenticated destructive endpoint, even a local one.