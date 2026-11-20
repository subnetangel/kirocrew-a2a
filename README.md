# a2a: Kiro Crew Bots ask each other

A [Kiro Crew](https://github.com/kirodotdev/KiroCrew) app that lets one Bot ask
another Bot a question and get that Bot's own answer, from its live thread with
its own memory and tools, over the A2A v1.0 JSON-RPC protocol. It opens no port:
everything rides the gateway's existing authenticated routes. Design notes are in
[DESIGN.md](DESIGN.md).

This is a community app. It is not an official Kiro Crew app and is not
maintained by the Kiro Crew team.

Requires Kiro Crew 0.13.0 or later (App Kit seam level 9), on Linux or macOS.

## What it does

- A Bot calls `a2a_call(agent, message)`; the other Bot answers in its own
  thread and the answer comes back to the caller, with a context id for
  follow-ups.
- `a2a_orchestrate(agents, message)` asks several Bots the same question at once
  and gathers their answers.
- The asked Bot's chat shows the message as one collapsed row
  (`A2A · <Bot> asks · turn 1/5`); the full message is one click away.
- The **A2A** page (sidebar) shows who may ask whom, the limits, per-Bot health,
  and a live feed of every exchange with question and answer.
- Optional **Chief of Staff mode** (0.6): one Bot you pick runs roll calls,
  collects escalations from the other Bots, flags work two Bots both mention, and,
  only if you turn it on, assigns work. See [Chief of Staff mode](#chief-of-staff-mode-06).

## Safety model

- **Deny by default.** A fresh install lets no Bot ask any Bot. You tick the
  pairs on the A2A page; the policy is stored where no agent sandbox can write it.
- **Answer-only.** The asked Bot is told to reply in plain text and change
  nothing. The asked Bot's own approval mode still applies to any tool it calls.
  The one exception is a Chief of Staff assignment, which is off unless you turn
  it on and waits for your Approve by default.
- **Untrusted-text fencing.** The peer's words reach the asked Bot inside a fence
  marked as untrusted data from another Bot, never as instructions from you.
  Forged fence markers are filtered, no peer line can start a slash command, and
  text the gateway's prompt-injection screen flags is refused.
- **Turn limit.** A conversation (one context id) allows 5 turns by default.
  You can set it from 1 to 10 on the A2A page. A Bot that is answering a peer
  cannot start a call or an orchestration of its own.
- **Refuse, don't trim.** A question over 8,000 characters, or an orchestration
  asking more Bots than you allow, is refused with the limit named, never cut
  short silently. (One exception: a reply longer than 20,000 characters is cut
  at that length.)
- **Credentials scrubbed** both ways with the gateway's own redaction; if
  redaction is unavailable, nothing is sent.
- **Audited.** Every send, refusal, orchestration and policy change goes to the
  gateway's Security Event Log and to the app's own log shown on the A2A page.

## Install

The app runs Python inside the Kiro Crew gateway (in-gateway hooks and routes)
and ships a stdio MCP server. Kiro Crew refuses third-party executable code until
you trust the app: when you enable it, accept the trust dialog (it trusts this app
only). Without that, you will see `app_execution_denied`.

### Install from GitHub with one-click updates

This repository is also a Kiro Crew app registry (`app-registry.json` on the
`release` branch). Needs Kiro Crew 0.13.0.1 or newer.

1. **Add the registry.** In **Discover**, open **Sources** (top right), then
   **External Registries > Add Registry**:
   - **Display Name:** `subnetangel-a2a`
   - **Repo:** `https://github.com/subnetangel/kirocrew-a2a` (no `.git`, no trailing slash)
   - **Branch:** `release`

   Save, then click **Sync registry apps**. Use the same name and URL on every
   machine: the update path is tied to them.
2. **Install.** In Discover, find **A2A: Bots ask each other** and click
   **Install**. Accept the trust dialog ("Trust 'A2A: Bots ask each other' to run
   its own code?"); it trusts this repository only.
3. **Enable it** on the app's page. Accept the consent to send messages into your
   Bots' chats (`sessionApproval` + `memberThreads`). Without that consent every
   send is refused.
4. **Tick your Bots** under "Bots this app can reach" and approve the grants the
   page lists (`/api/members`, `bots: read`), so a2a can wait for a busy Bot
   instead of queueing.
5. **Give each Bot the tools.** On the A2A page, press **Turn on A2A for all my
   Bots**. It lists every change before it applies anything.

**Updates:** click **Sync registry apps** in Sources, then **Update** on the app's
page. Discover and the bell show when a new version is published; nothing
updates on its own.

### Alternative: install from a terminal

```bash
kirocrew app install https://github.com/subnetangel/kirocrew-a2a
```

Then do steps 3 to 5 above. An install made this way does not get one-click
updates: to update, `git pull` the `release` branch into a local clone and run
`kirocrew app update a2a --source <that clone>`. You can also clone the
repository and add the folder under **Discover > Sources** as a local directory,
with the same update steps. Once the app is in the Kiro Crew App Store,
**Discover** lists it directly.

## Releasing

Releases are published on the `release` branch, which is the default branch.
Bump `version` in `app.json` and in `app-registry.json` in the same commit on
`release`; the two must match. If the registry version runs ahead of `app.json`,
the store keeps offering an update that never clears.

## Tools a Bot gets

| Tool | What it does |
|---|---|
| `a2a_list` | Which Bots you may message, the limits, and your Chief of Staff settings |
| `a2a_discover(agent)` | That Bot's Agent Card |
| `a2a_call(agent, message, context_id?)` | Ask; returns the reply and a context id for follow-ups |
| `a2a_orchestrate(agents, message)` | Ask several Bots at once, inside the owner's Bot and time budget |
| `a2a_result(request_id)` | Fetch a reply that took longer than 100 s |
| `a2a_history(context_id)` | A conversation you took part in |
| `a2a_cancel(task_id)`, `a2a_tasks()` | Cancel or list your own tasks (and, for the Chief of Staff, its `asg_...` assignments) |
| `a2a_escalate(title, why, ask)` | Any Bot but the Chief of Staff: flag something that needs you to the Chief of Staff's inbox |
| `a2a_rollcall(question?)` | Chief of Staff only: one status question to every Bot, merged into a brief |
| `a2a_inbox()` | Chief of Staff only: open escalations and its assignments' status |
| `a2a_assign(agent, title, brief, done_when, kind?)` | Chief of Staff only, when you allow it: assign work |
| `a2a_update(task_id, status, note)` | The assigned Bot only: `working`, `done` or `blocked` |

## Chief of Staff mode (0.6)

Pick one Bot as your Chief of Staff on the A2A page (**Chief of Staff** tab). None is
set until you pick one; the tab offers a suggestion you can take with one click.

Every new setting starts off or at its most cautious value:

| Setting | Default |
|---|---|
| `chief_of_staff` | none |
| `rollcall_schedule.enabled` (daily roll call) | off (06:45 America/Chicago once on) |
| `watch_terms` (project names to flag) | empty |
| `cos_can_assign` (assignments) | off |
| `assign_mode_default` | `normal` (Approve) |
| `fanout_others` | 3 Bots per question for every Bot but the Chief of Staff |
| `max_open_assignments` | 3 per Bot |

- **Fan-out.** Only the Chief of Staff may ask `"all"` Bots or more than
  `fanout_others` Bots in one `a2a_orchestrate` (default 3, 1 to 16). Every other
  Bot's longer list is refused, never trimmed. With no Chief of Staff set, nobody
  may ask `"all"`.
- **Roll call.** `a2a_rollcall` asks every one of your Bots "In-flight work, blocked
  items, and anything that needs you (one line each)." It is a status question only.
  The brief (each Bot's answer, or no-chat / timeout) is stored, the latest 10 show on
  the tab, and identifiers two Bots both name (`CR-123`, `P1234567`, `V123456789`,
  SIM-style `ABC-123`, and the project names you list) appear under **Overlaps**.
  Each roll call costs every Bot one turn. Overlaps are detection only; nothing
  acts on them.
- **Daily roll call.** A toggle on the tab, off by default, at 06:45
  America/Chicago unless you change it. The schedule runs inside the gateway (see
  DESIGN.md for why it is not an app cron), so it needs no extra permission.
- **Escalations.** Any Bot but the Chief of Staff can `a2a_escalate`. A repeat of the
  same title from the same Bot bumps a count. You close items with Done or Dismiss;
  the Chief of Staff reads open ones with `a2a_inbox`. Fields are capped at
  200/500/300 characters and share the send rate limit.
- **Assignments.** Off until you tick "Let the Chief of Staff assign work". Each
  assignment follows an approval mode, set as a default and per Bot:

  | Mode | What happens |
  |---|---|
  | Approve (`normal`, default) | Waits on the tab for Approve, Edit or Reject |
  | Trust reads | `kind: read` goes out at once as a read-only assignment; `change` waits |
  | Trust | Goes out at once and shows as unread on the tab |
  | YOLO | Goes out at once with no notice and no "ask first" line; needs a confirm, and the tab shows a red banner while it is on |

  A mode your Kiro Crew approval policy denies is greyed out and treated as Approve.
  The assigned Bot gets a new chat turn and works under its own tools and approval
  mode; a2a never widens either. At most 3 open assignments per Bot (1 to 10), a
  Bot can be opted out, assignments share the send rate limit, and one with no
  update for 24 hours closes as stale. Cancel stops a2a following the work; it
  cannot stop a turn the Bot already started.

## Changes in 0.6.1

- When a Bot can't call `a2a_update`, its final reply now counts as its
  assignment update. The assignment shows "Replied, no update", never Done.
- `a2a_list` now shows the Chief of Staff settings.
- After updating, reload each Bot's chat so it gets the current a2a tools.
- Permissions are unchanged from 0.6.0.

## Changes in 0.7.0

- New **Fleet** tab and `<crew>/<bot>` names for Bots on your other crews.
  **Fleet is off:** it needs Kiro Crew app peer calls
  ([#40040](https://github.com/kirodotdev/KiroCrew/issues/40040)), and until a
  release ships them every peer call is refused and nothing is sent. You can
  set up crews and pairs ahead of time.
- A page test no longer fails once its fixture dates are more than a day old.
- Permissions are unchanged from 0.6.1.

## Fleet (0.7): your other crews

A Bot can ask a Bot on another of **your own** Kiro Crews, named `<crew>/<bot>`
(for example `dev/alice`). This needs a core capability no Kiro Crew release has
yet ("app peer calls": `ctx.peers` and a peer token over the Remote Crew tunnel;
requested in [kirodotdev/KiroCrew#40040](https://github.com/kirodotdev/KiroCrew/issues/40040)).
**Fleet is off in 0.7.0: until a Kiro Crew ships app peer calls, every peer call
is refused with "peer seam not available" and nothing is sent.** The Fleet tab
says so.

- **Policy pairs on both ends.** On the crew that asks, the Fleet tab maps a crew
  name to a Remote Crew instance and lists `my Bot -> <crew>/<bot>`. On the crew
  that answers, it lists `<asking crew's id>/<bot> -> my Bot`. Both must agree.
- **Identity.** The answering crew learns which crew is calling only from the
  core's token claim, never from the request body. The Bot name after the slash is
  the asking crew's word, kept separate per crew.
- **Answer-only, one hop.** A peer turn is answer-only; a Bot answering one cannot
  call any Bot, here or on a third crew. `a2a_orchestrate` asks Bots on this crew
  only. The smaller turn cap of the two crews applies.
- **No listener, no token of its own.** Peer calls ride Kiro Crew's own Remote
  Crew tunnel through `ctx.peers`; a2a mints nothing.
- Routes: `GET /api/apps/a2a/peer/roster`, `POST /api/apps/a2a/peer/rpc/{slug}`
  (peer claim only; owner and app tokens are refused), `GET /api/apps/a2a/fleet`
  (owner). 0.7.0 asks for no new permission; a later version will add
  `permissions.peers` once Kiro Crew defines it.

## HTTP (A2A clients)

- `GET /api/apps/a2a/agents/{slug}/agent-card.json`
- `POST /api/apps/a2a/agents/{slug}/rpc` with `message/send` or `tasks/get`

Authenticate with the gateway's own dashboard or app token. The caller must be on
the allow list.

## Known limits

- The asked Bot's chat shows the message as sent by the app, not with the asking
  Bot's name and face: the gateway sets the author of every app send.
- Kiro Crew registers app MCP servers on the main agent only, so each Bot needs
  the `a2a` server added to its own worker.
- Answer-only is enforced by framing and the asked Bot's approval mode, not by a
  per-turn tool profile.
- An app cannot read a Bot's transcript, so a message the gateway queues behind a
  busy Bot is answered in that Bot's chat only.
- A Chief of Staff reads untrusted text (mail, chat, tickets), and its assignment
  text can carry that forward. That is why assignments are off by default and wait
  for your Approve; looser modes trade that review for speed.
- The daily roll call runs inside the gateway, not as a Kiro Crew cron, so it does
  not appear on the Schedule page.

## Tests

```bash
python -m pytest tests
```

Needs `aiohttp` and `pytest` (the Kiro Crew runtime ships aiohttp), and `node`
18+ for the page's logic tests (`tests/ui.test.mjs`, run from pytest).

## Feedback and security

Questions and ideas: the upstream discussion on inbound A2A,
[kirodotdev/KiroCrew#19228](https://github.com/kirodotdev/KiroCrew/issues/19228),
or this repository's issues. Security problems: see [SECURITY.md](SECURITY.md).

## License

MIT, copyright (c) 2026 subnetangel. See [LICENSE](LICENSE).
