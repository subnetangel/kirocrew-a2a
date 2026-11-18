"""Inbound A2A on the gateway's own authenticated surface (no listener of our own).

Mounted under ``/api/apps/a2a/``. The gateway's token middleware has already
refused any request without a dashboard or app token before these run, so the
caller identity is the host's: ``owner`` (the dashboard owner, via
``ctx.require_owner``) or ``app:<name>`` (an app token). Nothing in the body can
assert who is calling.

- ``GET  /agents/{slug}/agent-card.json``  the Bot's Agent Card (policy-gated)
- ``POST /agents/{slug}/rpc``              JSON-RPC 2.0: message/send, tasks/get
- ``GET  /policy`` / ``PUT /policy``       owner only
- ``GET  /audit``                          owner only, last N audit rows
- ``GET  /bots``, ``/conversations/{ctx}``   owner only, for the page
- ``GET  /session-bot?key=``, ``GET /bot/{slug}``, ``POST /tasks/{id}/cancel``:
  owner only, for the per-Bot chat side-panel tab. The session key is resolved to a
  Bot only through the gateway's own records (``hooks.caller_slug_for_session``).
- ``GET  /setup``                          owner only: the one-click setup plan and
  each Bot's a2a health, read only. The page applies the plan with the owner's own
  session through the host's capability API; no route here writes a Bot's spec.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from aiohttp import web

from . import hooks
from .core import INVALID_REQUEST, Policy, agent_card, rpc_error

_MAX_BODY = 64 * 1024


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    handler: Callable


def card_for(slug: str) -> dict:
    name = hooks.bot_name(slug) or slug
    description = ""
    try:
        agent = hooks._cfg().agents.get(name)
        description = str(getattr(agent, "description", "") or "")[:300]
    except Exception:  # noqa: BLE001
        pass
    return agent_card(slug, name, description, f"/api/apps/a2a/agents/{slug}/rpc")


async def _caller(request: web.Request, ctx: Any, op: str) -> tuple[str, web.Response | None]:
    """``(identity, refusal)``. App tokens are named by the host; any other caller
    must be the dashboard owner. A missing owner gate fails closed."""
    app = request.get("app")
    if app:
        return f"app:{app}", None
    gate = getattr(ctx, "require_owner", None)
    if gate is None:
        return "", web.json_response({"error": "owner authorization required", "code": "owner_only"}, status=403)
    denied = await gate(request, op)
    return ("", denied) if denied is not None else ("owner", None)


def _svc() -> Any:
    svc = hooks.service()
    if svc is None:
        raise web.HTTPServiceUnavailable(text="a2a is not running")
    return svc


async def get_card(request: web.Request, ctx: Any) -> web.Response:
    caller, denied = await _caller(request, ctx, "a2a.card")
    if denied is not None:
        return denied
    slug = request.match_info.get("slug", "")
    svc = _svc()
    # Same 404 for "no such Bot" and "not yours to ask": no existence oracle.
    if not svc.store.policy().permits(caller, slug) or not await asyncio.to_thread(hooks.bot_name, slug):
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(await asyncio.to_thread(card_for, slug))


async def post_rpc(request: web.Request, ctx: Any) -> web.Response:
    caller, denied = await _caller(request, ctx, "a2a.rpc")
    if denied is not None:
        return denied
    if (request.content_length or 0) > _MAX_BODY:
        return web.json_response(rpc_error(None, INVALID_REQUEST, "request too large"), status=413)
    raw = await request.read()
    if len(raw) > _MAX_BODY:
        return web.json_response(rpc_error(None, INVALID_REQUEST, "request too large"), status=413)
    slug = request.match_info.get("slug", "")
    label = "your owner (dashboard)" if caller == "owner" else caller
    return web.json_response(await _svc().handle_rpc(caller, label, slug, raw))


async def get_policy(request: web.Request, ctx: Any) -> web.Response:
    caller, denied = await _caller(request, ctx, "a2a.policy.read")
    if denied is not None:
        return denied
    if caller != "owner":
        return web.json_response({"error": "owner only", "code": "owner_only"}, status=403)
    return web.json_response(_svc().store.policy().to_dict())


async def put_policy(request: web.Request, ctx: Any) -> web.Response:
    caller, denied = await _caller(request, ctx, "a2a.policy.write")
    if denied is not None:
        return denied
    if caller != "owner":
        return web.json_response({"error": "owner only", "code": "owner_only"}, status=403)
    try:
        body = json.loads(await request.read())
    except ValueError:
        return web.json_response({"error": "invalid JSON"}, status=400)
    policy = Policy.from_dict(body)
    svc = _svc()
    before = svc.store.policy().to_dict()
    await asyncio.to_thread(svc.store.save_policy, policy)
    after = policy.to_dict()
    svc._audit("policy", "updated", by="owner", allow=json.dumps(after["allow"]),
               max_turns=after["max_turns_per_context"], orchestrate=json.dumps(after["orchestrate"]),
               changed=",".join(k for k in ("allow", "max_turns_per_context", "orchestrate", "scope")
                                if before.get(k) != after.get(k)))
    return web.json_response(policy.to_dict())


async def get_audit(request: web.Request, ctx: Any) -> web.Response:
    caller, denied = await _caller(request, ctx, "a2a.audit")
    if denied is not None:
        return denied
    if caller != "owner":
        return web.json_response({"error": "owner only", "code": "owner_only"}, status=403)
    try:
        limit = max(1, min(int(request.query.get("limit", "50")), 500))
    except ValueError:
        limit = 50
    path = _svc().store.audit_path
    lines = (await asyncio.to_thread(path.read_text, encoding="utf-8")).splitlines() if path.exists() else []
    return web.json_response({"rows": [json.loads(x) for x in lines[-limit:]]})


def register_routes(ctx: Any) -> list[Route]:
    return [
        Route("GET", "/agents/{slug}/agent-card.json", get_card),
        Route("POST", "/agents/{slug}/rpc", post_rpc),
        Route("GET", "/policy", get_policy),
        Route("PUT", "/policy", put_policy),
        Route("GET", "/audit", get_audit),
        Route("GET", "/bots", get_bots),
        Route("GET", "/conversations/{context}", get_conversation),
        Route("GET", "/setup", get_setup),
        Route("GET", "/session-bot", get_session_bot),
        Route("GET", "/bot/{slug}", get_bot_view),
        Route("POST", "/tasks/{task_id}/cancel", post_cancel_task),
    ]


async def _owner_only(request: web.Request, ctx: Any, op: str) -> web.Response | None:
    caller, denied = await _caller(request, ctx, op)
    if denied is not None:
        return denied
    if caller != "owner":
        return web.json_response({"error": "owner only", "code": "owner_only"}, status=403)
    return None


def is_roster_bot(name: str, agent: Any) -> bool:
    """Whether *name* is one of the owner's own Bots: the dashboard's Crewmates rule
    (``members.is_person_created_crewmate``: created here, with a member id). Built-in
    and app-installed agents that happen to carry a member id (workers, conductors, an
    app's own agents) are not, and a2a leaves them out of setup, Health and the grid."""
    return hooks.is_roster_bot(name, agent)


def _all_bots() -> list[dict]:
    """The owner's Bots (the dashboard's roster rule), each addressable by slug."""
    from kiro_crew import members as members_mod

    cfg = hooks._cfg()
    out = []
    for name, agent in cfg.agents.items():
        if not getattr(agent, "member_id", "") or not is_roster_bot(name, agent):
            continue
        try:
            slug = members_mod.member_slug(name, cfg)
        except Exception:  # noqa: BLE001
            continue
        # One with no thread yet is still a Bot (``chat: False``): the owner opens its chat once.
        if hooks.bot_name(slug) == name:
            out.append({"id": slug, "name": getattr(agent, "display_name", "") or name, "agent": name,
                        "chat": bool(hooks.thread_key(slug))})
    return sorted(out, key=lambda b: b["name"].lower())


def other_agents(allow: dict, roster: set) -> list[dict]:
    """Agents the policy names that are not roster Bots, with how many pairs name each.
    ``owner`` and ``app:<name>`` callers are not agents and are never listed."""
    counts: dict = {}
    for caller, targets in (allow or {}).items():
        names = [caller] + list(targets or [])
        for n in names:
            if n == "owner" or str(n).startswith("app:") or n in roster:
                continue
            counts[n] = counts.get(n, 0) + (len(targets or []) if n == caller else 1)
    return [{"id": k, "pairs": v} for k, v in sorted(counts.items())]


async def get_bots(request: web.Request, ctx: Any) -> web.Response:
    denied = await _owner_only(request, ctx, "a2a.bots")
    if denied is not None:
        return denied
    return web.json_response({"bots": [b for b in await asyncio.to_thread(_all_bots) if b["chat"]]})


async def get_conversation(request: web.Request, ctx: Any) -> web.Response:
    denied = await _owner_only(request, ctx, "a2a.conversation")
    if denied is not None:
        return denied
    from .core import is_id

    context = request.match_info.get("context", "")
    if not is_id(context):
        return web.json_response({"error": "not found"}, status=404)
    svc = _svc()
    rows = await asyncio.to_thread(svc.store.conversation, context, 200)
    return web.json_response({"context": context, "pair": (svc.store.read_context(context) or {}).get("pair"),
                              "messages": rows})


_APP_DIR = Path(__file__).resolve().parents[1]


def _app_version() -> str:
    try:
        return str(json.loads((_APP_DIR / "app.json").read_text(encoding="utf-8")).get("version") or "")
    except (OSError, ValueError):
        return ""


def closed_chats(rows: list) -> set:
    """Bots whose latest send failed because their chat thread is gone.

    A Bot can keep a chat binding after its thread was closed; the gateway then answers
    404 ``slot_not_found``, which the backend records as ``no chat yet``. A later
    successful send clears it.
    """
    out: set = set()
    for r in rows:
        if r.get("op") != "send" or not r.get("target"):
            continue
        err = str(r.get("error") or "")
        if r.get("outcome") == "error" and ("has no chat yet" in err or "slot_not_found" in err):
            out.add(r["target"])
        elif r.get("outcome") == "completed":
            out.discard(r["target"])
    return out


def _audit_tail(limit: int = 2000) -> list:
    svc = hooks.service()
    path = getattr(getattr(svc, "store", None), "audit_path", None)
    if path is None or not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[-limit:]:
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def _setup_view(allow: dict, audit_rows: list | None = None) -> dict:
    from . import setup

    python = setup.stable_python()
    transport = setup.stable_transport(_APP_DIR, python)
    bots, no_chat = [], []
    closed = closed_chats(audit_rows or [])
    for b in _all_bots():
        # A Bot with no chat thread cannot be asked yet, but it can still get its tools
        # (to ask others) and its pairs: setup must include it, never skip it.
        chat = bool(b.get("chat", True)) and b["id"] not in closed
        if not chat:
            no_chat.append({k: b[k] for k in ("id", "name", "agent")})
        owned, spec = hooks.read_bot_spec(b["agent"])
        bots.append({**b, "chat": chat, "owned": bool(owned and spec is not None), "unreadable": owned is None,
                     "spec": spec})
    view = setup.plan(bots, allow, transport)
    view.update({
        "version": _app_version(),
        "app_dir": str(_APP_DIR),
        "python": python,
        "python_ok": hooks.python_runs_server(python),
        # Bots with no chat thread yet: they cannot answer until the owner opens their chat once.
        "no_chat": no_chat,
        # Policy entries that name an agent outside the roster: kept until the owner removes them.
        "other_agents": other_agents(allow, {b["id"] for b in bots}),
    })
    if not view["python_ok"]:
        # No usable system python3: offer no mount ops rather than a command that cannot run.
        for row in view["bots"]:
            row["ops"] = [op for op in row["ops"] if op["section"] != "mcpServers"]
    return view


async def get_setup(request: web.Request, ctx: Any) -> web.Response:
    denied = await _owner_only(request, ctx, "a2a.setup")
    if denied is not None:
        return denied
    allow = _svc().store.policy().to_dict()["allow"]
    rows = await asyncio.to_thread(_audit_tail)
    return web.json_response(await asyncio.to_thread(_setup_view, allow, rows))


async def get_session_bot(request: web.Request, ctx: Any) -> web.Response:
    """Which roster Bot a chat session belongs to, from the gateway's own records.
    The key only selects what the owner looks at; it grants nothing."""
    denied = await _owner_only(request, ctx, "a2a.session_bot")
    if denied is not None:
        return denied
    key = request.query.get("key", "")
    slug = await asyncio.to_thread(hooks.caller_slug_for_session, key) if key else ""
    roster = {b["id"] for b in await asyncio.to_thread(_all_bots)}
    return web.json_response({"bot": slug if slug in roster else ""})


def _bot_view(slug: str, policy: dict) -> Optional[dict]:
    view = _setup_view(policy["allow"], _audit_tail())
    bot = next((b for b in view["bots"] if b["id"] == slug), None)
    if bot is None:
        return None
    ids = [b["id"] for b in view["bots"]]
    allow = policy["allow"]
    rows = [r for r in _audit_tail() if slug in (r.get("caller"), r.get("target"))
            or slug in str(r.get("targets", "")).split(",")]
    return {
        "bot": bot, "bots": [{"id": b["id"], "name": b["name"], "chat": b["chat"]} for b in view["bots"]],
        "may_ask": sorted(t for t in allow.get(slug, []) if t in ids),
        "asked_by": sorted(a for a in ids if slug in allow.get(a, [])),
        "rows": rows[-400:],
        "tasks": _svc().list_tasks("", bot=slug, as_owner=True, limit=50),
        "transport": view["transport"], "version": view["version"], "max_turns": policy["max_turns_per_context"],
    }


async def get_bot_view(request: web.Request, ctx: Any) -> web.Response:
    denied = await _owner_only(request, ctx, "a2a.bot_view")
    if denied is not None:
        return denied
    from .core import is_slug

    slug = request.match_info.get("slug", "")
    if not is_slug(slug):
        return web.json_response({"error": "not found"}, status=404)
    view = await asyncio.to_thread(_bot_view, slug, _svc().store.policy().to_dict())
    if view is None:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(view)


async def post_cancel_task(request: web.Request, ctx: Any) -> web.Response:
    denied = await _owner_only(request, ctx, "a2a.task_cancel")
    if denied is not None:
        return denied
    from .core import A2AError

    try:
        task = _svc().cancel_task("owner", request.match_info.get("task_id", ""), as_owner=True)
    except A2AError as err:
        status = 404 if err.code == -32001 else 409
        return web.json_response({"error": err.message, "code": err.reason or "task_not_found"}, status=status)
    return web.json_response(task)
