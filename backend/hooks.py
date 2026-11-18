"""In-gateway half of the a2a app: the host bindings and the outbox dispatcher.

Runs inside the Kiro Crew gateway (``backend.hooks``), so it may use the host's
own resolvers. Nothing here opens a socket: inbound traffic arrives through the
gateway's authenticated ``/api/apps/a2a/*`` routes (``routes.py``) or through
the app's ``outbox/`` directory, which the app's own stdio MCP server writes.
A turn reaches a Bot through ``POST /api/chat`` on the Bot's pinned thread,
with this app's own token, under ``permissions.sessionApproval`` +
``permissions.memberThreads`` (the owner's consent at enable time).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import types
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

from .core import A2AError, A2AService, Busy, Gateway, Queued, Store, is_id, is_slug

logger = logging.getLogger("kirocrew.app.a2a")

#: Outbox entries older than this are dropped unread; results are kept this long.
_OUTBOX_MAX_AGE = 300
_RESULT_TTL = 900
_POLL_SECS = 1.0
_MAX_OUTBOX_BYTES = 64 * 1024

#: The running service, shared by every copy of this module. The gateway's app loader
#: executes this file once per hook it resolves (routes, on_startup, on_shutdown), and
#: each run is a fresh module object; a plain module global would give the routes a
#: different, never-started copy (seen live as HTTP 503 "a2a is not running").
#: So the state lives in one process-wide registry keyed outside the loader's names.
_REGISTRY_KEY = "_kirocrew_app_a2a_runtime_registry"


def _shared_runtime() -> dict[str, Any]:
    reg = sys.modules.get(_REGISTRY_KEY)
    if reg is None:
        reg = types.ModuleType(_REGISTRY_KEY)
        reg.runtime = {}
        sys.modules[_REGISTRY_KEY] = reg
    return reg.runtime


_runtime: dict[str, Any] = _shared_runtime()


# ------------------------------------------------------------- host lookups


def _cfg():
    from kiro_crew.config.loader import KiroCrewConfig

    return KiroCrewConfig.load()


def bot_name(slug: str) -> Optional[str]:
    """The one addressable Bot behind *slug* (the host's own resolver), else None."""
    if not is_slug(slug):
        return None
    try:
        from kiro_crew.dashboard.handlers.members_app import _resolve

        return _resolve(_cfg(), slug)
    except Exception:  # noqa: BLE001 -- unknown is the safe answer
        logger.debug("a2a: could not resolve bot %s", slug, exc_info=True)
        return None


def is_roster_bot(name: str, agent: Any) -> bool:
    """The dashboard's Crewmates rule (``members.is_person_created_crewmate``)."""
    try:
        from kiro_crew import members as members_mod

        return bool(members_mod.is_person_created_crewmate(name, agent))
    except Exception:  # noqa: BLE001 -- unknown is not a Bot
        return False


def is_roster_slug(slug: str) -> bool:
    """Whether *slug* names one of the owner's own Bots (not mate, a worker or an app agent)."""
    name = bot_name(slug)
    if not name:
        return False
    try:
        agent = _cfg().agents.get(name)
    except Exception:  # noqa: BLE001
        return False
    return agent is not None and bool(getattr(agent, "member_id", "")) and is_roster_bot(name, agent)


def thread_key(slug: str) -> str:
    name = bot_name(slug)
    if not name:
        return ""
    try:
        from kiro_crew.dashboard.handlers.members_app import _thread_key

        return _thread_key(slug, name)
    except Exception:  # noqa: BLE001
        return ""


def caller_slug_for_session(session_key: str) -> str:
    """The Bot a session belongs to: its pinned thread, or one of its workers.

    Read from the gateway's own records (DM bindings in ``member-records/``,
    worker identities in process memory), never from the outbox entry.
    """
    if not isinstance(session_key, str) or not session_key or len(session_key) > 256:
        return ""
    try:
        from kiro_crew.members_parts.dm_bindings import member_identity_for_session

        ident = member_identity_for_session(session_key)
        if ident and is_slug(ident.get("slug")):
            return ident["slug"]
    except Exception:  # noqa: BLE001
        pass
    try:
        from kiro_crew.members_parts.member_sessions import crewmate_worker_member_id

        member = crewmate_worker_member_id(session_key)
        if member and is_slug(member):
            return member
    except Exception:  # noqa: BLE001
        pass
    return ""


_MAX_SPEC_BYTES = 1024 * 1024


def read_bot_spec(name: str) -> tuple[Optional[bool], Optional[dict]]:
    """``(owned, spec)`` for the Bot bound to *name*, READ ONLY.

    *owned* is the host's own test (``mate_capabilities.binding_is_mate``): the Bot
    owns ``mates/agents/<name>.json``, so the host's capability commit edits that file
    in place. A Bot on a shared template is ``(False, None)``. ``(None, None)`` means
    the check itself failed: unknown, which setup must never count as done. Nothing
    here writes; the owner's page applies changes through the host's capability API.
    """
    try:
        from kiro_crew.mate_capabilities import binding_is_mate
        from kiro_crew.mate_config import mate_config_path

        if not binding_is_mate(name):
            return False, None
        path = Path(mate_config_path(name))
        if path.stat().st_size > _MAX_SPEC_BYTES:
            return None, None
        spec = json.loads(path.read_text(encoding="utf-8"))
        return (True, spec) if isinstance(spec, dict) else (None, None)
    except Exception:  # noqa: BLE001 -- unknown is reported as unreadable, never guessed
        logger.warning("a2a: could not read the spec of %s", name, exc_info=True)
        return None, None


_PYTHON_OK: dict[str, bool] = {}


def python_runs_server(python: str) -> bool:
    """Whether *python* is 3.9 or newer (what ``mcp_server.py`` needs). Cached per path."""
    if not python:
        return False
    if python not in _PYTHON_OK:
        import subprocess

        try:
            out = subprocess.run([python, "-c", "import sys; print(sys.version_info >= (3, 9))"],
                                 capture_output=True, text=True, timeout=10, check=False)
            _PYTHON_OK[python] = out.stdout.strip() == "True"
        except (OSError, subprocess.SubprocessError):
            _PYTHON_OK[python] = False
    return _PYTHON_OK[python]


# ---------------------------------------------------------------- delivery

#: How long a2a waits for a busy Bot to finish its current turn before sending.
IDLE_WAIT_SECS = 240.0
IDLE_POLL_SECS = 3.0


async def _json_or_text(resp: Any) -> Any:
    raw = await resp.text()
    try:
        return json.loads(raw)
    except ValueError:
        return raw


async def bot_status(http: Any, origin: str, slug: str) -> str:
    """``busy``, ``idle``, or ``""`` when the owner has not granted ``bots: read``
    for this Bot (the roster then omits it, or the route refuses the app)."""
    async with http.get(f"{origin}/api/members") as resp:
        if resp.status != 200:
            return ""
        body = await _json_or_text(resp)
    for row in (body.get("data") or []) if isinstance(body, dict) else []:
        if isinstance(row, dict) and row.get("id") == slug:
            return str(row.get("status") or "")
    return ""


async def wait_until_idle(http: Any, origin: str, slug: str,
                          budget: float = IDLE_WAIT_SECS, poll: float = IDLE_POLL_SECS) -> None:
    """Return once *slug*'s thread is idle; raise :class:`Busy` past *budget*.
    Without the ``bots: read`` grant the status is unknown and this returns at once
    (the send may then queue, which the caller reports as ``working``)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget
    while True:
        status = await bot_status(http, origin, slug)
        if status != "busy":
            return
        if loop.time() >= deadline:
            raise Busy(slug)
        await asyncio.sleep(poll)


async def _deliver(ctx: Any, slug: str, text: str, banner: str = "") -> str:
    """Send *text* as one turn in *slug*'s pinned thread and return its reply text."""
    import aiohttp

    key = await asyncio.to_thread(thread_key, slug)
    if not key:
        raise A2AError(-32602, no_chat_message(slug))
    origin = ctx.gateway_origin() if hasattr(ctx, "gateway_origin") else ""
    token = await ctx.app_token()
    if not origin or not token:
        raise A2AError(-32050, "the a2a app holds no gateway token (disabled?)")
    cookie = {f"mc_token_{urlsplit(origin).port}": token}
    chunks: list[str] = []
    finals: list[str] = []
    timeout = aiohttp.ClientTimeout(total=None, sock_read=330)
    async with aiohttp.ClientSession(timeout=timeout, cookies=cookie) as http:
        # A busy thread QUEUES the send, and an app token may not read a Bot's
        # transcript, so a queued turn's reply could never come back. Wait for the
        # thread to go idle first, through the sanctioned busy/idle read
        # (permissions.bots "read", the Bots the owner ticked for this app).
        await wait_until_idle(http, origin, slug)
        async with http.post(f"{origin}/api/chat", json=chat_body(key, text, banner)) as resp:
            if resp.status in (401, 403, 404):
                raise A2AError(-32050, refusal_message(slug, resp.status, (await resp.text())[:200]))
            if "text/event-stream" not in resp.headers.get("Content-Type", ""):
                body = await _json_or_text(resp)
                if isinstance(body, dict) and body.get("queued"):
                    raise Queued(str(body.get("queue_id") or ""))
                raise RuntimeError(f"the Bot's thread did not stream a turn ({resp.status}): {str(body)[:200]}")
            async for raw in resp.content:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except ValueError:
                    continue
                if isinstance(event, dict) and event.get("type") == "chunk":
                    chunks.append(str(event.get("content") or ""))
                elif isinstance(event, dict) and event.get("type") == "assistant":
                    finals.append(str(event.get("content") or ""))
    return reply_text(chunks, finals)


def no_chat_message(slug: str) -> str:
    """What a caller is told when *slug* has never had a chat thread to answer in."""
    name = bot_name(slug) or slug
    return f"{name} has no chat yet; ask your owner to open {name}'s chat once, then try again."


def refusal_message(slug: str, status: int, body: str) -> str:
    """The gateway's refusal of a send, in words. A 404 ``slot_not_found`` means the
    Bot's chat thread does not exist (it was never opened, or it was closed)."""
    code = ""
    try:
        code = str((json.loads(body) or {}).get("code") or "")
    except (ValueError, AttributeError):
        pass
    if status == 404 and code == "slot_not_found":
        return no_chat_message(slug)
    return f"gateway refused the send ({status}): {body}"


def chat_body(slot: str, text: str, banner: str) -> dict:
    """The /api/chat body. ``banner`` collapses the row in the target's chat; the
    content and the model's input stay the full fenced message."""
    body = {"slot": slot, "message": text}
    if banner:
        body["banner"] = banner
    return body


def reply_text(chunks: list[str], finals: list[str]) -> str:
    """The turn's answer. A stream carries the tokens as ``chunk`` rows and then the
    whole message as an ``assistant`` row; joining both doubled every reply."""
    return "".join(finals) if any(f.strip() for f in finals) else "".join(chunks)


def _gateway(ctx: Any) -> Gateway:
    untrusted = getattr(ctx, "untrusted", None)

    def scrub(text: str) -> str:
        return ctx.scrub.outbound(text).text  # raises -> core fails closed

    def audit(op: str, outcome: str, resources: str) -> None:
        ctx.audit.record(op, outcome, resources=resources)

    return Gateway(
        resolve_target=bot_name,
        is_roster=is_roster_slug,
        deliver=lambda slug, text, banner="": _deliver(ctx, slug, text, banner),
        scrub=scrub,
        neutralize=(untrusted.neutralize if untrusted else (lambda s: s)),
        flagged=(untrusted.flagged if untrusted else (lambda s: False)),
        audit=audit,
    )


def service() -> Optional[A2AService]:
    return _runtime.get("service")


# ------------------------------------------------------------ outbox loop


def _write_result(store: Store, rid: str, payload: dict) -> None:
    from .core import _atomic_write

    _atomic_write(store.results / f"{rid}.json", json.dumps(payload))


async def _handle_entry(svc: A2AService, path: Path) -> None:
    store = svc.store
    rid = path.stem
    claimed = store.private / "claimed" / path.name
    try:
        claimed.parent.mkdir(parents=True, exist_ok=True)
        os.replace(path, claimed)  # claim: a second dispatcher pass never sees it
        if claimed.stat().st_size > _MAX_OUTBOX_BYTES:
            raise ValueError("entry too large")
        entry = json.loads(claimed.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.info("a2a: dropped outbox entry %s: %s", path.name, exc)
        _safe_unlink(claimed)
        return
    try:
        st = claimed.stat()
        inode = (st.st_dev, st.st_ino)
    except OSError:
        inode = (0, 0)
    if not is_id(rid) or not isinstance(entry, dict) or entry.get("id") != rid:
        _safe_unlink(claimed)
        return
    if time.time() - float(entry.get("created") or 0) > _OUTBOX_MAX_AGE:
        _safe_unlink(claimed)
        return
    session = str(entry.get("session") or "")
    op = entry.get("op")
    # The kernel, not the file, says who wrote it: the named pid must be this app's
    # MCP server, hold the entry open, and run on the session it names.
    refusal = await asyncio.to_thread(verify_writer, entry.get("pid"), inode, session)
    _safe_unlink(claimed)
    if refusal:
        svc._audit(str(op), "denied", reason=f"writer_unverified: {refusal}", session=session[:80])
        _write_result(store, rid, {"ok": False, "error": "a2a could not verify which session wrote this "
                                    f"request ({refusal})."})
        return
    caller = await asyncio.to_thread(caller_slug_for_session, session)
    if not caller:
        svc._audit(str(op), "denied", reason="caller_unidentified", session=session[:80])
        _write_result(store, rid, {"ok": False, "error": "a2a could not tell which Bot is calling "
                                    "(this session is not a Bot's thread or worker)."})
        return
    label = await asyncio.to_thread(bot_name, caller) or caller
    try:
        if op == "call":
            target = str(entry.get("agent") or "").strip().lower()
            task = await svc.send(caller, label, target, str(entry.get("message") or ""),
                                  str(entry.get("context_id") or ""))
            _write_result(store, rid, {"ok": True, "task": task})
        elif op == "orchestrate":
            agents = entry.get("agents")
            agents = [str(a).strip().lower() for a in agents] if isinstance(agents, list) else []
            out = await svc.orchestrate(caller, label, agents, str(entry.get("message") or ""))
            _write_result(store, rid, {"ok": True, "orchestration": out})
        elif op == "cancel":
            task = svc.cancel_task(caller, str(entry.get("task_id") or ""))
            _write_result(store, rid, {"ok": True, "task": task})
        elif op == "tasks":
            tasks = svc.list_tasks(caller, str(entry.get("context_id") or ""), "", int(entry.get("limit") or 20))
            _write_result(store, rid, {"ok": True, "tasks": tasks})
        elif op == "history":
            rows = svc.history(caller, str(entry.get("context_id") or ""), int(entry.get("limit") or 50))
            _write_result(store, rid, {"ok": True, "messages": rows})
        elif op == "list":
            policy = store.policy()
            peers = sorted(policy.allow.get(caller, ()))
            _write_result(store, rid, {"ok": True, "caller": caller, "peers": peers,
                                       "max_turns": policy.max_turns, "scope": policy.scope})
        elif op == "discover":
            target = str(entry.get("agent") or "").strip().lower()
            if not store.policy().permits(caller, target) or not bot_name(target):
                raise A2AError(-32050, "not permitted by the owner's a2a policy")
            from .routes import card_for

            _write_result(store, rid, {"ok": True, "card": card_for(target)})
        else:
            _write_result(store, rid, {"ok": False, "error": "unknown op"})
    except A2AError as err:
        _write_result(store, rid, {"ok": False, "code": err.code, "error": err.message})


# --------------------------------------------------------- writer binding


def _proc_chain(pid: int, proc: Path, limit: int = 32) -> list[int]:
    chain = []
    while pid > 1 and len(chain) < limit:
        chain.append(pid)
        try:
            stat = (proc / str(pid) / "stat").read_text()
            pid = int(stat.rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return chain


def _bound_sessions(pid: int) -> frozenset[str]:
    from kiro_crew.runtime_ownership import session_keys_bound_to_pid

    return session_keys_bound_to_pid(pid)


def _norm_session(key: str) -> str:
    for prefix in ("dashboard:", "dashboard_"):
        if key.startswith(prefix):
            return key[len(prefix):]
    return key


def verify_writer(pid: Any, inode: tuple[int, int], session: str, *, proc: Path = Path("/proc"),
                  bound: Any = None, app_root: Optional[Path] = None) -> str:
    """``""`` when process *pid* wrote this outbox entry for *session*, else why not.

    1. *pid* runs this app's ``backend/mcp_server.py`` (its command line).
    2. *pid* holds the entry file open: one of its fds is the same inode, which
       only the writing process can arrange (the MCP server keeps it open until
       the answer is read).
    3. The gateway's own ownership tables (``runtime_ownership``, in gateway
       memory) place *session* on the nearest ancestor of *pid* they know.
    Fail closed: no evidence is a refusal.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1 or not session:
        return "no writer pid"
    base = proc / str(pid)
    root = (app_root or Path(__file__).resolve().parents[1]).resolve()
    try:
        argv = [a for a in (base / "cmdline").read_bytes().split(b"\0") if a]
    except OSError:
        return "writer process is gone"
    server = str(root / "backend" / "mcp_server.py").encode()
    if not any(a == server or a.endswith(b"/apps/a2a/backend/mcp_server.py") or a == b"backend/mcp_server.py"
               for a in argv):
        return "writer is not the a2a MCP server"
    held = False
    try:
        for fd in (base / "fd").iterdir():
            try:
                st = os.stat(fd)
            except OSError:
                continue
            if (st.st_dev, st.st_ino) == tuple(inode):
                held = True
                break
    except OSError:
        return "cannot inspect the writer's open files"
    if not held:
        return "writer does not hold this request open"
    lookup = bound or _bound_sessions
    want = _norm_session(session)
    for ancestor in _proc_chain(pid, proc):
        try:
            keys = lookup(ancestor)
        except Exception:  # noqa: BLE001 -- unreadable tables are no evidence
            keys = frozenset()
        if keys:
            return "" if want in {_norm_session(k) for k in keys} else "session is not on the writer's runtime"
    return "the gateway does not place any session on the writer's runtime"


def _safe_unlink(p: Path) -> None:
    try:
        p.unlink()
    except OSError:
        pass


def _sweep_results(store: Store) -> None:
    cutoff = time.time() - _RESULT_TTL
    for p in store.results.glob("*.json"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


async def _dispatch_loop(svc: A2AService) -> None:
    inflight: set[asyncio.Task] = set()
    last_sweep = 0.0
    while True:
        try:
            for path in sorted(svc.store.outbox.glob("*.json")):
                task = asyncio.create_task(_handle_entry(svc, path))
                inflight.add(task)
                task.add_done_callback(inflight.discard)
            if time.time() - last_sweep > 60:
                await asyncio.to_thread(_sweep_results, svc.store)
                last_sweep = time.time()
        except asyncio.CancelledError:
            for t in inflight:
                t.cancel()
            raise
        except Exception:  # noqa: BLE001 -- keep serving
            logger.warning("a2a: dispatcher pass failed", exc_info=True)
        await asyncio.sleep(_POLL_SECS)


# --------------------------------------------------------------- lifecycle


def _seed_policy(store: Store) -> None:
    """First start only: take ``policy.seed.json`` from the installed tree, the
    copy the owner installed, when no policy exists yet. Later edits go through the
    owner-only ``PUT /policy``; a seed file changed after that is never read."""
    if store.policy_path.exists():
        return
    seed = Path(__file__).resolve().parents[1] / "policy.seed.json"
    try:
        data = json.loads(seed.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    from .core import Policy

    store.save_policy(Policy.from_dict(data))
    store.audit({"op": "policy", "outcome": "seeded", "allow": Policy.from_dict(data).to_dict()["allow"]})


def protected_dir(ctx: Any) -> Optional[Path]:
    """A gateway-only directory for the policy, contexts and audit log: under the
    data home's ``member-records/``, which the OS sandbox masks in every mode and the
    agent file tools refuse. ``None`` when this host has no such directory.

    shortcut: borrows a core-internal path; upgrade to an App Kit protected-storage
    seam when one exists.
    """
    try:
        from kiro_crew.member_records import records_root

        root = records_root()
    except Exception:  # noqa: BLE001
        return None
    return root / "app-a2a"


def _migrate_private(old: Path, new: Path) -> list[str]:
    """Move state the 0.1/0.2 builds kept in ``data/private`` into *new*, once."""
    import shutil

    moved = []
    if not old.is_dir() or old.resolve() == new.resolve():
        return moved
    new.mkdir(parents=True, exist_ok=True)
    for name in ("policy.json", "audit.jsonl", "contexts", "conversations", "tasks"):
        src, dst = old / name, new / name
        if src.exists() and not dst.exists():
            shutil.move(str(src), str(dst))
            moved.append(name)
    return moved


_TERMINAL = frozenset({"completed", "timeout", "queued", "busy", "error", "canceled"})
#: Older than this, a delivery with no outcome cannot still be running (the idle wait plus
#: the turn are capped at 600 s).
_STALE_SECS = 900


def close_stale_deliveries(store: Store, now: Optional[float] = None) -> int:
    """Append an ``error`` row for every ``delivering`` send that never got an outcome.

    0.3.x raised a gateway refusal (404 ``slot_not_found``) without closing its audit
    row, and a gateway restart can cut a turn off mid-send; both left a turn counted and
    the feed showing "in progress" forever. Each is closed once, and its turn given back.
    """
    import calendar

    path = store.audit_path
    if not path.exists():
        return 0
    now = time.time() if now is None else now
    open_rows: dict[str, dict] = {}
    errored: dict[str, dict] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        task = row.get("task")
        if row.get("op") != "send" or not task:
            continue
        if row.get("outcome") == "delivering":
            open_rows[task] = row
        elif row.get("outcome") in _TERMINAL:
            open_rows.pop(task, None)
            if row.get("outcome") == "error":
                errored[task] = row
    closed = 0
    # 0.5.0 left a gateway-refused send's task WORKING after its error row: close those too.
    from .core import STATE_FAILED, make_task

    for task, row in errored.items():
        saved = store.load_task(task) if is_id(task) else None
        if saved and (saved.get("status") or {}).get("state") == "TASK_STATE_WORKING":
            failed = make_task(task, str(row.get("context") or ""), STATE_FAILED,
                               str(row.get("error") or "Delivery failed")[:300])
            store.save_task({**failed, **{k: v for k, v in saved.items() if k.startswith("_")}})
            closed += 1
    for task, row in open_rows.items():
        try:
            started = calendar.timegm(time.strptime(str(row.get("ts", ""))[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            continue
        if now - started < _STALE_SECS:
            continue
        ctx_id = str(row.get("context") or "")
        if ctx_id and is_id(ctx_id):
            data = store.read_context(ctx_id)
            if data and data.get("turns", 0) > 0:
                data["turns"] -= 1
                store.write_context(ctx_id, data)
        saved = store.load_task(task) if is_id(task) else None
        if saved and (saved.get("status") or {}).get("state") == "TASK_STATE_WORKING":
            from .core import STATE_FAILED, make_task

            closed_task = make_task(task, ctx_id, STATE_FAILED, "No outcome was recorded; closed at startup.")
            store.save_task({**closed_task, **{k: v for k, v in saved.items() if k.startswith("_")}})
        store.audit({"op": "send", "outcome": "error", "caller": row.get("caller"), "target": row.get("target"),
                     "context": ctx_id, "task": task, "reason": "stale",
                     "error": "no outcome was recorded (refused by the gateway or cut off); closed at startup"})
        closed += 1
    return closed


async def on_startup(ctx: Any) -> None:
    private = protected_dir(ctx)
    store = Store(Path(ctx.data_dir), private)
    if private is None:
        ctx.health.mark_degraded("no gateway-only directory on this host: the a2a policy sits in the "
                                 "app's data dir, which agent sandboxes may be able to write")
    else:
        moved = await asyncio.to_thread(_migrate_private, Path(ctx.data_dir) / "private", private)
        if moved:
            await asyncio.to_thread(store.ensure)
            store.audit({"op": "migrate", "outcome": "moved", "items": moved,
                         "note": "review the policy on the a2a page: the old copy was agent-writable"})
    await asyncio.to_thread(store.ensure)
    await asyncio.to_thread(_seed_policy, store)
    closed = await asyncio.to_thread(close_stale_deliveries, store)
    if closed:
        logger.info("a2a: closed %d stale deliveries", closed)
    svc = A2AService(store, _gateway(ctx))
    _runtime["service"] = svc
    _runtime["ctx"] = ctx
    _runtime["task"] = asyncio.get_running_loop().create_task(_dispatch_loop(svc))
    logger.info("a2a: started; data dir %s", store.root)


async def on_shutdown(ctx: Any) -> None:
    task = _runtime.pop("task", None)
    if task is not None:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    _runtime.pop("service", None)
    _runtime.pop("ctx", None)
