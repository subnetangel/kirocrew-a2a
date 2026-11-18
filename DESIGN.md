# a2a for Kiro Crew: design

Goal: one Bot on a gateway asks another Bot a question and gets that Bot's own
answer, from its live thread with its own memory, workspace and tools. Built as
an app with zero edits to Kiro Crew core, the way Hermes Agent built A2A as a
plugin (`plugins/platforms/a2a/` in NousResearch/hermes-agent, MIT). Nothing
here is copied from Hermes; the shapes are reimplemented.

## Hermes pieces and their Kiro Crew counterparts

| Hermes | Kiro Crew a2a app |
|---|---|
| `ctx.register_platform()` adapter, stdlib `http.server` on its own port | No listener. In-gateway `backend.hooks.routes` under `/api/apps/a2a/*`, behind the gateway's token middleware |
| Agent Card at `/.well-known/agent-card.json` | `GET /api/apps/a2a/agents/{slug}/agent-card.json`, one card per Bot, policy-gated |
| JSON-RPC `message/send`, `tasks/get` | `POST /api/apps/a2a/agents/{slug}/rpc`, same methods (v1.0 and legacy names) |
| Live-session injection keyed by `contextId` | `POST /api/chat` into the target Bot's pinned thread with the app's own token, under `permissions.sessionApproval` + `permissions.memberThreads`; the reply is read off that send's SSE stream |
| `ctx.register_tool()` client tools | The app's stdio MCP server: `a2a_list`, `a2a_discover`, `a2a_call`, `a2a_result`, `a2a_history` |
| `A2A_PEER_TOKENS`, bearer auth, bind 127.0.0.1 | The gateway's own auth (dashboard owner or app token). No secret minted |
| `A2A_TRUSTED_PEERS` | Owner policy `allow: {caller: [targets]}`, deny by default |
| `A2A_MAX_PINGPONG_TURNS` | `max_turns_per_context`, default 5 (Channels' `_MAX_A2A_EXCHANGES` is 3), hard max 10, counted per context in both directions |
| Injection filters + privacy prefix | Fenced, defanged peer text with an answer-only header; the host's `ctx.untrusted` screen and neutralizer |
| `redact_outbound` | `ctx.scrub.outbound` on the question and the reply; a scrub failure sends nothing |
| `~/.hermes/a2a_audit.jsonl` | `ctx.audit` (Security Event Log) plus `data/private/audit.jsonl` |
| `a2a_conversations/<ctx>.jsonl` | `data/private/conversations/<ctx>.jsonl`, readable only through `a2a_history` by a participant |

Left out this round: streaming, push notifications, `tasks/cancel`,
`a2a_orchestrate`, cross-machine peers.

## How a call flows

Outbound (Assistant asks Research Bot):

1. Assistant calls `a2a_call(agent="researcher", message=...)`. The MCP server, running
   in Assistant's sandbox with no credential, writes one JSON file to
   `data/outbox/` with its session label and polls `data/results/<id>.json`.
2. The in-gateway dispatcher claims the file and works out the caller from the
   gateway's own records: `member_identity_for_session` (a Bot's pinned thread)
   or `crewmate_worker_member_id` (one of its workers). A `caller` field in the
   file is ignored.
3. The core applies policy, checks the target exists, claims a turn on the
   context, scrubs and frames the text, and sends it as one turn into Research Bot's
   pinned thread (`POST /api/chat`, `slot: member-researcher...`).
4. Research Bot answers in its own thread, with its own memory. The dispatcher reads
   the reply off the SSE stream, scrubs it, records it, and writes the A2A Task
   to `results/`. The MCP server returns it to Assistant, marked as peer data.

Inbound over HTTP (another app, or the owner's own tooling): the same core,
reached through `/rpc` with the caller named by the gateway (`owner` or
`app:<name>`).

## Security

- **No new socket.** Routes ride the gateway's existing listener
  (`127.0.0.1:5476` here). An unauthenticated request gets the gateway
  middleware's 403 `Token required` before any app code runs.
- **Owner decides, never the caller.** Policy lives in `data/private/`, which
  `credentialMasks` hides from every sandboxed process, and changes only
  through the owner-gated `PUT /policy` (or a one-time seed from the installed
  tree). No policy file means deny all. An unknown scope fails closed.
- **Consent to reach Bots.** `memberThreads` is a scope the owner consents to
  on the app's detail page; until then the gateway refuses every send.
- **Answer only.** #19228's first scope. Enforced today by framing plus the
  target Bot's own approval mode; inbound text cannot reach a slash command,
  an agent binding or a mode change, because the gateway refuses those from
  app sends (`_deny_app_session_settings`), the turn always opens with `[`,
  and no peer line starts with `/`.
- **Loop cap and no cross-talk.** A context belongs to the pair that opened
  it; a third Bot cannot ride it or read it. One open turn per context: a Bot
  that calls back on the same context while answering is refused at once
  instead of deadlocking.
- **Audit.** Every decision (denied, rejected, delivering, completed,
  timeout, error, policy change) goes to `ctx.audit` and the JSONL log.

### Known limit and the smallest core hook

The MCP server's session label is a name, not a credential. Any same-user
process can write an outbox file naming another Bot's session. The dispatcher
maps the name through the gateway's records, so it cannot invent a Bot, but it
cannot prove the writer is that Bot. Kiro Crew already has the fix:
`agentTools` with `strictSession: true` hands an in-gateway route a
gateway-attested `X-Session-Key`. Today the gateway lists `agentTools` only for
first-party apps. The accepted RFC
`rfc-app-agent-tools-third-party-grant.md` (#32727) adds an owner grant for
third-party apps. Once that lands, a2a declares its tools as `agentTools`,
drops its MCP server and outbox, and the caller is attested. As a builtin it
would get this today. No other core change is needed.

## Fit with the upstream threads

- **#10162** (RFC, remote agents as subagents over A2A, draft): outbound to
  foreign agents at the subagent seam, with `secret://` tokens pinned to the
  Agent Card URL. a2a is the other half: Bots on one gateway as A2A servers.
  Its Agent Card and JSON-RPC shapes are what an `A2AProvider` would call, so
  #10162 can address a Kiro Crew Bot without new code here.
- **#19228** (inbound A2A with operator-set scope): a2a implements the
  inbound endpoint, operator policy, answer-only scope and `contextId`
  sessions. "File an issue" and "direct fix" scopes, and tying the scope to the
  receiving process's tool permissions, need a per-turn tool profile for app
  sends; that is a core question for #19228.
- **#23808** (Bots as Channel participants): Channels are a shared room the
  human watches; a2a is a direct one-to-one question. Both bind to the real
  Bot. a2a does not change Channels; its own default is 5 turns (Channels uses 3).

## Cross-machine (out of scope)

A peer on another machine would reach `/api/apps/a2a/agents/{slug}/rpc`
through Kiro Crew's Remote Crew path or an SSH local port-forward to the
gateway's loopback port, authenticating with that gateway's own token. No
port is widened. The `#10162` `A2AProvider` is the natural client.

## 0.3.0 additions

**Busy targets.** A send to a Bot that is mid-turn is queued by the gateway,
and an app may not read a Bot's transcript, so a queued answer can never come
back. Before sending, a2a waits up to 240 s for the target to go idle, reading
busy/idle through `GET /api/members` (`permissions.bots: ["read"]`, the Bots
the owner ticked). Still busy: nothing is sent, the caller gets `rejected` and
the turn is given back. Queued anyway: the caller gets `working` and is told the
answer lands only in the target's chat. Repeats of the same question to the same
Bot within 5 minutes return the open task instead of sending again.

**State the agents cannot write.** The policy, contexts, conversations, tasks
and audit log moved from the app's data dir to `member-records/app-a2a/`, which
the OS sandbox masks in every mode and the agent file tools refuse. Only the
in-gateway half writes it. The first 0.3.0 start moves the old files once and
logs a `migrate` row asking the owner to review the policy. shortcut: this
borrows a core path (`member_records.records_root`); an App Kit
protected-storage seam is the upstream fix.

**Writer binding for the outbox.** An outbox entry now names the pid of the MCP
server that wrote it, and that server keeps the file open until its answer
arrives. The dispatcher accepts an entry only when the kernel and the gateway
agree: `/proc/<pid>/cmdline` is this app's `mcp_server.py`, one of that pid's
open fds is the entry's inode, and the gateway's in-memory ownership tables
(`runtime_ownership.session_keys_bound_to_pid`) place the named session on that
pid's nearest known ancestor. A Bot's shell that writes an entry, or starts its
own copy of the server with another Bot's label, fails the fd or the ancestry
check. No evidence is a refusal. Residual: two sessions sharing one runtime
process cannot be told apart by ancestry.

**Orchestration.** `a2a_orchestrate(agents, message)` asks up to `max_bots`
Bots (default 4, hard max 16 since 0.4.0) the same question at once, one turn each on a fresh
context, under one time budget for the whole run (default 300 s, hard max 600).
Every target passes the same policy as a single call. Answers come back as peer
data. Every exchange carries the run id in the audit log.

**No calls from inside a peer message.** While a Bot is answering a peer, any
`a2a_call` or `a2a_orchestrate` it (or one of its workers) makes is refused, so
a peer message cannot make a Bot fan out or chain to a third Bot.

**Settings page.** The app page (`/a2a`) shows a who-may-ask-whom grid, the
turn and orchestration limits, recent audit rows, and any conversation by
context id. It reads and writes only the owner-gated `/policy`, `/bots`,
`/audit` and `/conversations/{id}` routes. (Rebuilt in 0.4.0, below.)

**What would make this zero-touch (core-hook proposals).** 0.4.0's one-click
setup gets close with today's APIs; these two core changes would remove the
remaining owner steps. Neither is needed for the app to work, and nothing in the
app asks the owner to use a terminal.
- *Author on the incoming message.* The gateway stamps every app send with the
  app as author (`shared_crew.attribution.stamp_message_author` overwrites any
  client value), so the target's chat cannot show the asking Bot's name and face.
  A core option to attribute an app send "on behalf of" a Bot, checked against
  the writer binding, would do it.
- *Tools on every Bot.* App MCP servers are registered into the main agent only
  (`apps.bridges_mcp._register_mcp_servers`); Bots keep their own agent specs,
  and no manifest field reaches them. Today the owner adds `a2a:a2a` to each Bot
  with the dashboard's MCP card. A core field such as
  `mcpServers.<name>.reach: ["bots"]`, applied only to the Bots the owner ticks
  under `permissions.bots`, would mount it on all of them with one consent.

## 0.3.1

**Collapsed rows.** Each send to a Bot's thread carries `/api/chat`'s `banner`,
`A2A · <caller> asks · turn 1/5` or, for an orchestration, `A2A · <caller> asks
3 Bots · run abc123`. The target's chat shows that label. The row's content and
the model's input stay the full fenced message, so the guardrails still reach
the model. The banner is built only from the caller's owner-set Bot name (reduced
to letters, digits and `._()-`, at most 40 characters) and numbers, never from
peer text. The gateway reads `banner` for every caller with no person-send gate
(`chat_send._api_chat_send` → `autonudge_authz.normalize_banner`, cap 500, redacted).

**Orchestration runs on the page.** A run id in the audit list opens every Bot
that run asked, each with question and answer.

## 0.4.0

**The page, rebuilt.** Native ESM on the host's React and lucide-react (the
host's import map provides both, so there is no bundle and no build step), and
the dashboard's own theme variables, so dark and light both work. Activity leads:
a live feed grouped by conversation and orchestration run, with filters for Bot,
outcome and kind (kept in the URL), refusals worded in plain language, and each
item expanding to the full question and answer. A new item slides in once and
keeps a "New" highlight until it is opened or marked seen. The controls ride a
sticky rail: a who-may-ask-whom matrix (rows ask, columns answer, one tab stop with
arrow keys, row and column toggles, Allow all and Allow none), limits as
steppers, and per-Bot health. Every data region has loading, empty and error
states, and errors show the real HTTP status.

**One-click setup.** A first-run panel shows while setup is incomplete. Its
button opens a review of every change, then applies them in order with the
owner's own signed-in session:

1. `PUT /api/apps/a2a/policy` (owner only): every Bot may ask every other Bot;
   other callers and the limits are kept.
2. `PUT /api/apps/a2a/bot-grants` (the host's owner-only route): every Bot ticked
   under "Bots this app can reach".
3. Per Bot, the host's capability API, exactly as the dashboard's change cards
   call it: `GET /api/agents/b64/{name}/capabilities` for the revision,
   `POST .../capabilities/preview` for the impact rows and `preview_token`
   (writes nothing), and only after the owner confirms,
   `PUT .../capabilities` with that token. The host writes the Bot's own
   `mates/agents/<name>.json` in place and reloads its workers at their turn end.

The plan comes from a new read-only, owner-only `GET /api/apps/a2a/setup`
(`backend/setup.py`, pure). The backend holds the app token and never names an
owner-only host route (a test checks every string in `backend/`); every such call
is made by the page through the host SDK's `useAppApi()`, which carries the owner's
session and the manifest scope. That needs one new `permissions.api` entry,
`/api/agents/b64`, which the gateway holds back until the owner approves the
update. A Bot on a shared template (no file of its own) gets no automatic ops; the
page sends the owner to that Bot's Capabilities.

**Upgrade-proof mount.** kiro-cli runs the a2a server with whatever `command` a
Bot's spec names. Earlier per-Bot cards named the gateway's versioned runtime
Python (`~/.local/state/kirocrew-internal/runtime/<version>/...`), which every
Kiro Crew upgrade deletes. The setup and Repair write
`/usr/bin/python3 ~/.kiro/crew/apps/a2a/backend/mcp_server.py` (the first system
`python3` found, never the runtime's, checked to be 3.9 or newer) with
`x-kirocrew-session-label: true`. The Health panel checks per Bot: the server is
mounted and on, the command exists and is outside the runtime folder, the script
is this app's installed copy, and every a2a tool is enabled and allowed. Repair
re-applies the same reviewed path for one Bot or all.

**Why Python stays.** The backend must run inside the gateway, which is a Python
process that loads app hooks and routes as Python. The stdio MCP server stays
stdlib-only so it runs on any host `python3` 3.9 or newer, which is what makes the
stable command possible.

**Fan-out to every Bot.** `a2a_orchestrate(agents=["all"])` asks every Bot the
owner's policy lets the caller ask, that still exists and that is one of the
owner's roster Bots (the dashboard's Crewmates rule), sorted by id. Policy entries
for agents off the roster, such as `mate` or an app's agent, are skipped and don't
count toward the limit; naming one explicitly still works if the policy allows it. The hard
cap is now 16 Bots per run; the owner default stays 4, and the one-click setup
offers to raise it to all the owner's Bots, with the count shown. A run that asks
for more Bots than the owner's limit is refused with a message naming both
numbers; it is never trimmed. One time budget covers the whole run. Every result
is tagged with its Bot and its own state (`completed`, `failed` for a timeout,
`rejected` for a busy Bot, `refused`, `error`), so one slow or busy Bot does not
sink the others. The page shows each run as one card with every Bot's answer and
its own outcome.

**Keeping the A2A surface spec-shaped.** The JSON-RPC route speaks only A2A
methods: `message/send` / `SendMessage` and `tasks/get` / `GetTask`, with v1.0
`Task`, `Message` and `TASK_STATE_*` shapes; any other method gets JSON-RPC
`-32601`. Orchestration is not a protocol method: it is a fan-out of ordinary
`message/send` turns, one context and one stored `Task` per Bot, so an A2A client
sees nothing non-standard. That leaves room for the rest of the spec without a
break: streaming as `message/stream` (SSE) on the same `/rpc` route, since the
gateway already streams the Bot's reply; `tasks/cancel` against the stored task
ids; `TASK_STATE_INPUT_REQUIRED` for a Bot that asks back, alongside the states
already returned; and artifacts, since a completed `Task` already carries its
answer as an artifact part. None of these is built in 0.4.0.

**v1.0.1 card and error hygiene.** The Agent Card now matches A2A v1.0.1
§4.4-4.5: no top-level `protocolVersion` (it lives on each `supportedInterfaces`
entry), `securityRequirements: [{"schemes": {"kiroCrewGateway": {"list": []}}}]`
instead of the v0.3 `security`, and `securitySchemes.kiroCrewGateway` as the v1.0
union member `{"apiKeySecurityScheme": {"location": "cookie", "name": ...}}` instead
of OpenAPI's `type`/`in`. The `provider` block is dropped, because `AgentProvider`
requires a `url` this app has no honest value for. Errors: the custom -32052 is
retired, because Bedrock AgentCore's A2A contract uses -32052 for a validation
error. A message the host's injection screen refuses is now -32602 Invalid params,
and a redaction outage is -32603 Internal error. Each carries an `error.data`
`google.rpc.ErrorInfo` detail (`reason` `MESSAGE_REFUSED_BY_SCREEN` or
`REDACTION_UNAVAILABLE`, `domain` `kirocrew.a2a`). The custom authorization code
-32050 stays, since A2A leaves authorization errors to a custom code.

**Why `/api/agents/b64` is safe for the app token (checked on 0.13.0.1).** `permissions.api` scopes only the APP TOKEN: `kiro_crew/dashboard/token_auth_app_scope.py` `_enforce_app_scope()` calls `app_token_path_allowed()` only when the request carries an app claim, and is a no-op for the owner's dashboard session. So the entry lets the a2a app token *reach* the routes below; it does not let it *use* them. Each route's handler runs the owner gate `require_owner_dashboard_request()` (`dashboard/handlers/_shared_access.py`), which calls `is_owner_dashboard_request()` (`dashboard/handlers/source_providers.py`). That returns False whenever `request["app"] != ""`, and an app token always carries its app name there. The capability routes call the gate directly (`dashboard/handlers/agent_capabilities.py` `api_member_capabilities`, `api_member_capabilities_detach`), and so do the worker-kit routes (`dashboard/handlers/member_worker_kit.py` `api_member_worker_kit`). The delete and avatar routes reach it through `dashboard/handlers/agents.py` `_require_owner()`. So only the owner's signed-in page can preview or commit.

**Residual: everything else under the prefix.** These are all the routes 0.13.0.1 registers under `/api/agents/b64/` (`dashboard/routes/agents.py` `register()`). There is no plain "read agent" route under `b64`; the spec-bearing reads are `GET .../capabilities` and `GET .../worker-kit`.

| Method and route | Handler | Gate |
|---|---|---|
| `DELETE /api/agents/b64/{name}` | `agent_admin/crew_removal.py` `api_kirocrew_agent_delete` | `_require_owner` |
| `GET`/`HEAD /api/agents/b64/{name}/avatar` | `handlers/agents.py` `api_kirocrew_agent_avatar_get` | `_require_owner`, except a Kiro-relay-verified team teammate (`members_access._teammate_admitted`), never an app token |
| `POST /api/agents/b64/{name}/avatar` | `agent_admin/avatars.py` `api_kirocrew_agent_avatar_upload` | `_require_owner` |
| `GET`/`HEAD`, `POST .../preview`, `POST .../detach`, `PUT .../capabilities` | `agent_capabilities.api_member_capabilities` and `api_member_capabilities_detach` | `require_owner_dashboard_request` |
| `GET`/`HEAD`, `POST .../preview`, `PUT .../worker-kit` | `member_worker_kit.api_member_worker_kit` | `require_owner_dashboard_request` |

None of them is reachable by the app token: none lets it read a Bot's spec, its worker kit or its avatar, or change anything. Calling every one of the 13 method and route pairs as the a2a app token (`request["app"] = "a2a"`) on 0.13.0.1 returned 403 `owner_only` each time (0.13.0.1, 2026-11-18). The test `tests/test_host_gates.py` repeats that check against whatever routes the host registers, so a future host that adds an ungated route under the prefix fails it. It runs under the Kiro Crew runtime and skips elsewhere.

**Why a prefix, and not something narrower.** `_api_pattern_matches()` in `token_auth_app_scope.py` supports exact entries (`=/path`), a trailing `/*` or `*`, and a bare prefix. It has no wildcard in the middle of a path, so `/api/agents/*/capabilities` cannot be written. The Bot name is dynamic, so exact entries cannot be listed ahead of time. `/api/agents/b64` is the narrowest prefix that covers the capability routes. It leaves out the path-form `/api/agents/{name}` routes, and with them create, sync, update, list, templates and models.

## 0.4.1

**Layout collapse.** The 0.4.0 page rendered about 160 px wide in the dashboard. `.a2a`
was a size container (`container: a2a / inline-size`) with `max-width` and auto
margins but no `width`. Inline-size containment sizes the element as if it had no
content, so the auto margins shrank it to its minimum. Fix: `width: 100%` on `.a2a`, and
`width: min(40rem, 100% - 2rem)` on the review dialog. With no browser on the build
machine, a static test now fails any rule that sets a size container without a width.

**Counts.** The status strip's Bot count is the Bots a2a can answer through: members
with a live chat thread (`GET /setup` `bots`). It never came from the "Bots this app can
reach" ticks. Health reads "N of M need repair", where M counts only Bots that own their
settings. A Bot whose chat binding outlived its thread (the gateway's 404
`slot_not_found`, recorded in the audit as "no chat yet") now moves to the no-chat
list until a send to it succeeds. Ticks that name no reachable Bot, and reachable Bots
that are not ticked, are listed on their own lines.

## 0.4.5

**Bots are the roster.** a2a now counts only the owner's own Bots, using the
dashboard's Crewmates rule (`members.is_person_created_crewmate`: created on this
dashboard, with a member id). That one list feeds setup, Health, the counts, "All my
Bots" and the grid. Workers, conductors and an app's own agents carry member ids too,
but they are not Bots, so setup could never complete while they were counted. Policy
entries that still name such an agent show under "Other agents in the policy", with a
Remove action that writes the policy after an in-place confirm. Nothing is removed
automatically.

**Tabs.** The status strip stays on top. While setup is incomplete, a one-line banner
("Setup: N steps left", Finish setup) opens the same review, and the checklist sits in
a disclosure. Below it, a WAI-ARIA tablist (Activity, Who may ask whom, Limits,
Health) with roving tabindex and arrow, Home and End keys gives each section the full
width. The last tab is remembered, and `?tab=` deep-links. The matrix has 2.25rem
squares, sticky row and column names, and horizontal column names that turn sideways
only below 56rem. Each row and column has its own All and None, and a read-out on hover
or focus. Health is a grid of cards, and Limits a two-column form.

**Feed.** Consecutive identical failures (same caller, target, outcome and reason)
fold into one row marked "×N", which expands to each attempt. The feed shows the last
24 hours by default.

**Default turn cap 5.** `DEFAULT_MAX_TURNS` is 5 (was 3); `HARD_MAX_TURNS` stays 10. A
saved policy keeps its own value, and setup never changes it. A saved value below 1 reads
as 1, above 10 as 10, and a non-number as the default.

## 0.5.0

**A2A tab in each Bot's chat side panel** (`contributes.panelTabs`, `ui/panel.mjs`). The
0.13.0.1 app SDK documents `useAppInfo().session.sessionKey` as present for a panel tab,
the same key the scoped client sends as `X-Session-Key`. The tab sends that key to the
owner-only `GET /session-bot`, which maps it to a Bot through the gateway's own records
(`hooks.caller_slug_for_session`) and answers only with a roster Bot. The key picks what
the owner sees and grants nothing. A chat that isn't a Bot's, or a host without the field,
gets a Bot picker that remembers the last choice, and "Open in A2A" deep-links to
`/apps/a2a?bot=<id>`. The tab shows this Bot's health, with a chat-open check and the
reviewed Repair. Below that are its matrix row and column as checkboxes, each change saved
through the owner-only `PUT /policy`, which keeps every other pair. Then its open tasks
with Cancel, and its conversations with the full question and answer. New owner-only
read routes: `GET /session-bot` and `GET /bot/{slug}`, plus `POST /tasks/{id}/cancel`. No
new listener. `panelTabs` is not a staged grant family on 0.13.0.1 (`STAGED_GRANT_FAMILIES`
holds api, events, the link/message/composer/selection points, workerAutoApprove,
reachableByUserSessions, desktopCapabilities, bots and frameSources), so adding the tab
asks for no new approval. The update notes say so.

**Task control.**
- `tasks/cancel` (CancelTask): a2a stops waiting, drops any answer that still arrives,
  stores the task as `TASK_STATE_CANCELED` and gives the turn back. A finished task answers
  -32002 TaskNotCancelable.
- `tasks/list` (ListTasks) returns only the caller's own tasks.
- `configuration.returnImmediately` (or `blocking: false`) on `message/send` returns a
  `WORKING` task once every check has passed; the turn continues in the background.
- Per-caller rate limit: owner-set `rate_limit` in the policy, default 30 sends per 10
  minutes (bounds 1-300 sends, 60-3600 s). Past it, -32603 with ErrorInfo `RATE_LIMITED`.
- New tools `a2a_cancel` and `a2a_tasks`. Replies now carry the task id.

**What would make cancel real (core-hook proposal).** An app may not interrupt a Bot's
thread, so cancel cannot stop the asked Bot's turn. It may still finish its reply in its
own chat, and `a2a_cancel` says so. A core hook letting an app with `memberThreads` stop
the turn it started would make cancel end the work too.

**Input-required (0.5.1, decided).** The asked Bot may end its answer with one line,
`A2A-NEEDS-INPUT: <question>`. a2a then returns `TASK_STATE_INPUT_REQUIRED` with that
question, which is untrusted, scrubbed and capped at 500 characters. The caller answers on
the same task, and each round counts against the turn cap.

**Files (0.5.3, checked).** `/api/chat` carries attachments as `meta.files` and
`meta.dirs`, which are paths on this machine, not uploaded bytes (`chat_send.attachment_meta`).
A file part would mean a2a writing peer bytes to disk and handing the asked Bot a path.
That is a sandbox question to settle in 0.5.3 before building. Until then, data parts only.

## 0.5.1

**Why 0.5.0's setup failed.** Health marked 8 of 9 Bots "Needs repair" only because the two new tools (`a2a_cancel`, `a2a_tasks`) weren't allowed. The setup review then ran its capability previews 3 at a time on a loaded box. Each `GET /api/agents/b64/<id>/capabilities` hit the gateway's 20 s read deadline (`_GET_TIMEOUT_SECS`) and answered 503 `capabilities_unavailable`.

**Health tiers.** "Needs repair" means a required part is broken: the server isn't mounted or is off, the command is missing or inside the upgrade-deleted runtime folder, the script is another copy, the session label is off, or one of the 6 core tools is missing. Tools a newer a2a added and the Bot doesn't have yet show **Update available** (amber), and the Bot counts as healthy.

**Auto-heal.** When the owner opens the A2A page or a Bot's panel tab, every Bot whose only drift is newer a2a tools gets them through the same owner preview, then PUT. There's no button press, and Bots go one at a time. A status line reads "Updated N Bots to the 0.5.1 tool list", with Undo, which removes exactly the entries it added. The backend's `heal` ops are allowedTools `@a2a:a2a...` entries only. A Bot without the server, or with any required fault, is never healed; that's Repair's job, with a review. A failed Bot stays amber and is tried again on the next page load. The owner setting "Keep my Bots' A2A tools up to date" (policy `auto_update_tools`, default on) under Limits turns it off.

**Server-level entry.** 0.13.0.1's spec schema accepts `@a2a:a2a` in `allowedTools` as "the whole server" (`agent_spec_schema._tool_entry_problem`). Heal and Repair add it alongside the per-tool entries, so tools a later a2a adds need no heal. Health counts it as every tool allowed. Trade-off: any tool a future a2a ships runs without a prompt on that Bot. Every a2a tool is answer-only and policy-gated, so this is the owner's own app widening its own grant. If a governance ceiling strips the entry, the per-tool entries still apply.

**Previews** run one at a time. A 503 is retried twice, 5 s apart, inside a 75 s per-Bot deadline, and the dialog shows each Bot's preview time.

**0.5.1 also:**
- **Panel scrolling.** The side-panel tab's root (`.a2a.a2a-side`) is its own scroll container: `height: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain`. The page root `.a2a` is unchanged. The name `.a2a-panel` belongs to the page's tab panels, so the rule stays off it.
- **Stuck "In progress" tasks.** In 0.5.0, a send the gateway refused (no chat yet) left its saved `WORKING` task in place, because only the audit row closed. Now the task is saved as `FAILED` with the refusal text. On startup, any `WORKING` task whose audit shows an error, or a delivery with no outcome after 15 minutes, is closed as `FAILED` once.
