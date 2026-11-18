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

## Safety model

- **Deny by default.** A fresh install lets no Bot ask any Bot. You tick the
  pairs on the A2A page; the policy is stored where no agent sandbox can write it.
- **Answer-only.** The asked Bot is told to reply in plain text and change
  nothing. The asked Bot's own approval mode still applies to any tool it calls.
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

1. **Install it** from a terminal on the machine that runs your gateway:
   ```bash
   kirocrew app install https://github.com/subnetangel/kirocrew-a2a
   ```
   Or clone the repository and add the folder under **Apps > Discover > Sources**
   (the gear in the Discover header), which installs a local directory. Once the
   app is in the Kiro Crew App Store, **Discover** lists it directly.
2. **Enable it** on the app's page. Accept the trust dialog and the consent to
   send messages into your Bots' chats (`sessionApproval` + `memberThreads`).
   Without that consent every send is refused.
3. **Approve the grants** the app page lists (`/api/members`, `bots: read`), and
   tick the Bots under "Bots this app can reach", so a2a can wait for a busy Bot
   instead of queueing.
4. **Give each Bot the tools.** Add the `a2a` MCP server to each Bot's worker
   (one card per Bot), or press **Turn on A2A for all my Bots** on the A2A page,
   which lists every change before it applies anything.

To update: `kirocrew app update a2a`, or **Update** on the app's page.

## Tools a Bot gets

| Tool | What it does |
|---|---|
| `a2a_list` | Which Bots you may message, and the limits |
| `a2a_discover(agent)` | That Bot's Agent Card |
| `a2a_call(agent, message, context_id?)` | Ask; returns the reply and a context id for follow-ups |
| `a2a_orchestrate(agents, message)` | Ask several Bots at once, inside the owner's Bot and time budget |
| `a2a_result(request_id)` | Fetch a reply that took longer than 100 s |
| `a2a_history(context_id)` | A conversation you took part in |

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

Apache-2.0. See [LICENSE](LICENSE).
