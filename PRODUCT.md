# Product

<!-- impeccable:product-schema 1 -->

Inferred from the owner's written brief for v0.4 (no live interview was run; the
brief was relayed by the owner's chief-of-staff Bot). Facts marked *(inferred)*
come from the brief or the code, not from a direct answer.

## Platform

web

## Users

The owner of one Kiro Crew gateway: a single person who runs several Bots
(persistent agents, each with its own memory, tools and chat thread) on their own
machine. They open the A2A page from the dashboard sidebar on a laptop, in the
same dark or light theme as the rest of the dashboard, to decide which Bot may ask
which, to set limits, and to see what the Bots asked each other. *(inferred)*

## Product Purpose

A2A lets one Bot ask another Bot a question and get that Bot's own answer from its
own thread, inside limits the owner sets. The page is the owner's control room for
it: turn it on, choose who may ask whom, set limits, read every exchange, and keep
each Bot's tools mounted across upgrades. Success: the owner can turn it on in one
press, see at a glance that it is healthy, and find any exchange in seconds.

## Positioning

Bot-to-Bot questions on one gateway with no new listener: the gateway's own
authenticated routes, the owner's policy, deny by default, answer-only, a 3-turn
cap per conversation, and an audit row for every decision.

## Operating Context

- Lives inside the Kiro Crew dashboard as an app page (`/apps/a2a`), rendered by
  the host's React with the host's theme variables.
- Every write is an owner action from the owner's signed-in page: the app's own
  `PUT /policy`, the host's `PUT /api/apps/a2a/bot-grants`, and the host's
  per-Bot capability preview + commit. The app token never calls owner APIs.
- A Kiro Crew upgrade deletes the versioned Python runtime, so a Bot whose a2a
  server was mounted with that interpreter loses its tools. *(inferred)*

## Capabilities and Constraints

- Answer-only scope; turns per conversation 1-10 (default 5); orchestration up to
  16 Bots (default 4; `agents=["all"]` asks every Bot the caller may ask) and 10-600 s (default 300).
- Exchange outcomes: delivering, completed, working (queued), rejected, denied,
  timeout, error. Ops: send, orchestrate, policy, migrate.
- No render or screenshot tooling on the build machine; the owner reviews the
  page by eye.
- Fully offline: no CDN, no remote fonts.

## Evidence on Hand

Real audit rows and conversations exist on the owner's gateway. No metrics,
quotes or logos exist and none may be invented.

## Product Principles

1. The owner decides; the page never acts without showing every change first.
2. Deny by default is visible, never hidden: a refusal is as findable as an answer.
3. Health before features: if a Bot cannot reach its tools, that is the first thing on screen.
4. One press for the common case, full control for the rest.

## Accessibility & Inclusion

Keyboard and screen-reader accessible; respects reduced motion; both dashboard
themes.
