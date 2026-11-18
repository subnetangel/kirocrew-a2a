"""In-process harness: MCP server -> outbox -> dispatcher -> core -> results -> MCP server,
and the HTTP routes' caller gate. The host lookups are faked; nothing listens."""

from __future__ import annotations

import asyncio
import os
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import hooks, mcp_server, routes  # noqa: E402
from backend.core import A2AService, Gateway, Policy, Store  # noqa: E402

SESSIONS = {"dashboard:member-assistant.memory-x": "assistant", "worker-of-writer": "writer"}
BOTS = {"assistant": "Assistant", "researcher": "Research Bot", "writer": "Writer"}


def _service(tmp_path, delivered):
    store = Store(tmp_path)
    store.ensure()
    store.save_policy(Policy.from_dict({"allow": {"assistant": ["researcher"]}}))

    async def deliver(slug, text, banner=""):
        delivered.append((slug, text))
        return f"{BOTS[slug]} answers: I research things."

    return A2AService(store, Gateway(resolve_target=BOTS.get, deliver=deliver, scrub=lambda s: s))


def _drain_outbox(svc):
    async def go():
        for p in sorted(svc.store.outbox.glob("*.json")):
            await hooks._handle_entry(svc, p)
    asyncio.run(go())


def _call_with_dispatcher(svc, fn, args, session, monkeypatch):
    """Run an MCP tool while a dispatcher thread drains the outbox, as the gateway would."""
    monkeypatch.setattr(hooks, "caller_slug_for_session", lambda s: SESSIONS.get(s, ""))
    monkeypatch.setattr(hooks, "bot_name", lambda s: BOTS.get(s))
    monkeypatch.setattr(hooks, "verify_writer", lambda *a, **k: "")  # the kernel check has its own tests
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", session)
    stop = threading.Event()

    def pump():
        while not stop.is_set():
            _drain_outbox(svc)
            stop.wait(0.1)

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    try:
        return fn(args, None, svc.store.root)
    finally:
        stop.set()
        t.join(2)


def test_mcp_call_round_trip_and_follow_up(tmp_path, monkeypatch):
    delivered: list = []
    svc = _service(tmp_path, delivered)
    out = _call_with_dispatcher(svc, mcp_server.tool_call,
                                {"agent": "Researcher", "message": "[A2A test] what are you for?"},
                                "dashboard:member-assistant.memory-x", monkeypatch)
    assert out.startswith("[Researcher | context ") and "completed" in out
    assert "I research things" in out
    ctx = out.split("context ", 1)[1].split(" |", 1)[0]
    again = _call_with_dispatcher(svc, mcp_server.tool_call,
                                  {"agent": "researcher", "message": "follow-up", "context_id": ctx},
                                  "dashboard:member-assistant.memory-x", monkeypatch)
    assert f"context {ctx}" in again
    assert "turn 2 of 5" in delivered[1][1]
    hist = _call_with_dispatcher(svc, mcp_server.tool_history, {"context_id": ctx},
                                 "dashboard:member-assistant.memory-x", monkeypatch)
    assert "follow-up" in hist


def test_mcp_unidentified_session_is_refused(tmp_path, monkeypatch):
    delivered: list = []
    svc = _service(tmp_path, delivered)
    out = _call_with_dispatcher(svc, mcp_server.tool_call, {"agent": "researcher", "message": "hi"},
                                "dashboard:someone-else", monkeypatch)
    assert out.startswith("Error: a2a could not tell which Bot is calling")
    assert delivered == []


def test_mcp_bot_not_on_allow_list_is_refused(tmp_path, monkeypatch):
    delivered: list = []
    svc = _service(tmp_path, delivered)
    out = _call_with_dispatcher(svc, mcp_server.tool_call, {"agent": "researcher", "message": "hi"},
                                "worker-of-writer", monkeypatch)
    assert out == "Error: not permitted by the owner's a2a policy"
    assert delivered == []


def test_outbox_entry_cannot_name_its_own_caller(tmp_path, monkeypatch):
    """A 'caller' field in the entry is ignored: identity comes from the session only."""
    delivered: list = []
    svc = _service(tmp_path, delivered)
    monkeypatch.setattr(hooks, "caller_slug_for_session", lambda s: SESSIONS.get(s, ""))
    monkeypatch.setattr(hooks, "bot_name", lambda s: BOTS.get(s))
    monkeypatch.setattr(hooks, "verify_writer", lambda *a, **k: "")
    rid = mcp_server._submit({"op": "call", "agent": "researcher", "message": "hi", "caller": "assistant",
                              "session": "worker-of-writer"}, svc.store.root)
    _drain_outbox(svc)
    res = json.loads((svc.store.results / f"{rid}.json").read_text())
    assert res["ok"] is False and delivered == []


def test_mcp_server_speaks_jsonrpc():
    init = mcp_server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert init["result"]["serverInfo"]["name"] == "a2a"
    names = {t["name"] for t in mcp_server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]}
    assert {"a2a_call", "a2a_discover", "a2a_list", "a2a_history", "a2a_result"} <= names
    bad = mcp_server.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "nope"}})
    assert bad["error"]["code"] == -32602


def test_mcp_caller_meta_block_wins_over_label(monkeypatch):
    monkeypatch.setenv("KIROCREW_SESSION_LABEL", "label-key")
    meta = {"kirocrew.caller": {"schemaVersion": 1, "sessionKey": "meta-key"}}
    assert mcp_server._session(meta) == "meta-key"
    assert mcp_server._session(None) == "label-key"


# ------------------------------------------------------------ routes caller gate


class _Req(dict):
    def __init__(self, app=None):
        super().__init__()
        if app:
            self["app"] = app


class _Ctx:
    def __init__(self, owner: bool):
        self.owner = owner

    async def require_owner(self, request, op):
        from aiohttp import web

        return None if self.owner else web.json_response({"code": "owner_only"}, status=403)


def test_routes_caller_identity():
    async def go():
        assert await routes._caller(_Req(app="other-app"), _Ctx(False), "op") == ("app:other-app", None)
        assert (await routes._caller(_Req(), _Ctx(True), "op"))[0] == "owner"
        ident, denied = await routes._caller(_Req(), _Ctx(False), "op")
        assert ident == "" and denied.status == 403

        class NoGate:
            pass

        ident, denied = await routes._caller(_Req(), NoGate(), "op")
        assert ident == "" and denied.status == 403  # missing owner gate fails closed
    asyncio.run(go())


def test_seed_policy_only_when_absent(tmp_path, monkeypatch):
    store = Store(tmp_path / "data")
    store.ensure()
    seed = tmp_path / "policy.seed.json"
    seed.write_text(json.dumps({"allow": {"assistant": ["researcher"]}}))
    monkeypatch.setattr(hooks, "__file__", str(tmp_path / "backend" / "hooks.py"))
    hooks._seed_policy(store)
    assert store.policy().permits("assistant", "researcher")
    seed.write_text(json.dumps({"allow": {"writer": ["researcher"]}}))
    hooks._seed_policy(store)  # a policy exists: the seed is never read again
    assert not store.policy().permits("writer", "researcher")


class _Resp:
    def __init__(self, status, body):
        self.status, self._body = status, body

    async def text(self):
        return json.dumps(self._body)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _Http:
    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = 0

    def get(self, url):
        self.calls += 1
        st = self.statuses.pop(0) if self.statuses else "idle"
        if st is None:
            return _Resp(403, {"code": "forbidden"})
        return _Resp(200, {"data": [{"id": "researcher", "status": st}]})


def test_wait_until_idle_waits_then_returns():
    http = _Http(["busy", "busy", "idle"])
    asyncio.run(hooks.wait_until_idle(http, "http://x", "researcher", budget=5, poll=0.01))
    assert http.calls == 3


def test_wait_until_idle_gives_up_with_busy():
    from backend.core import Busy

    http = _Http(["busy"] * 1000)
    try:
        asyncio.run(hooks.wait_until_idle(http, "http://x", "researcher", budget=0.05, poll=0.01))
    except Busy:
        return
    raise AssertionError("expected Busy")


def test_wait_until_idle_without_bots_grant_does_not_block():
    http = _Http([None])
    asyncio.run(hooks.wait_until_idle(http, "http://x", "researcher", budget=5, poll=0.01))
    assert http.calls == 1



# ------------------------------------------------------------ writer binding


def _fake_proc(tmp_path, entry, *, cmd=b"/rt/python3\0/apps/a2a/backend/mcp_server.py\0", hold=True):
    proc = tmp_path / "proc"
    for pid, ppid in ((4242, 4000), (4000, 1)):
        d = proc / str(pid)
        (d / "fd").mkdir(parents=True)
        (d / "stat").write_text(f"{pid} (x) S {ppid} 0 0")
        (d / "cmdline").write_bytes(cmd if pid == 4242 else b"kiro-cli\0")
    if hold:
        (proc / "4242" / "fd" / "3").symlink_to(entry)
    return proc


def _entry(tmp_path):
    f = tmp_path / "entry.json"
    f.write_text("{}")
    st = f.stat()
    return f, (st.st_dev, st.st_ino)


def test_verify_writer_accepts_the_real_writer(tmp_path):
    f, ino = _entry(tmp_path)
    proc = _fake_proc(tmp_path, f)
    bound = lambda pid: frozenset({"dashboard:member-assistant.memory-x"}) if pid == 4000 else frozenset()
    assert hooks.verify_writer(4242, ino, "dashboard:member-assistant.memory-x", proc=proc, bound=bound) == ""


def test_verify_writer_refuses_a_spoofed_session(tmp_path):
    """A Bot's shell runs its own MCP server with another Bot's label: its runtime is its own."""
    f, ino = _entry(tmp_path)
    proc = _fake_proc(tmp_path, f)
    bound = lambda pid: frozenset({"dashboard:member-writer.memory-y"}) if pid == 4000 else frozenset()
    assert "not on the writer" in hooks.verify_writer(4242, ino, "dashboard:member-assistant.memory-x",
                                                      proc=proc, bound=bound)


def test_verify_writer_refuses_a_pid_that_does_not_hold_the_file(tmp_path):
    f, ino = _entry(tmp_path)
    proc = _fake_proc(tmp_path, f, hold=False)
    assert "does not hold" in hooks.verify_writer(4242, ino, "s", proc=proc, bound=lambda p: frozenset({"s"}))


def test_verify_writer_refuses_other_programs_and_no_evidence(tmp_path):
    f, ino = _entry(tmp_path)
    proc = _fake_proc(tmp_path, f, cmd=b"/bin/sh\0-c\0echo\0")
    assert "not the a2a MCP server" in hooks.verify_writer(4242, ino, "s", proc=proc, bound=lambda p: frozenset({"s"}))
    proc2 = _fake_proc(tmp_path / "b", f)
    assert "does not place" in hooks.verify_writer(4242, ino, "s", proc=proc2, bound=lambda p: frozenset())
    assert hooks.verify_writer(None, ino, "s") == "no writer pid"


def test_mcp_server_holds_its_entry_open_until_answered(tmp_path):
    rid = mcp_server._submit({"op": "list", "session": "s"}, tmp_path)
    fh = mcp_server._HELD[rid]
    on_disk = (tmp_path / "outbox" / f"{rid}.json").stat()
    assert os.fstat(fh.fileno()).st_ino == on_disk.st_ino
    assert json.loads((tmp_path / "outbox" / f"{rid}.json").read_text())["pid"] == os.getpid()
    (tmp_path / "results").mkdir()
    (tmp_path / "results" / f"{rid}.json").write_text('{"ok": true}')
    assert mcp_server._wait(rid, tmp_path, 2) == {"ok": True}
    assert rid not in mcp_server._HELD and fh.closed


def test_unverified_writer_is_refused_end_to_end(tmp_path, monkeypatch):
    delivered: list = []
    svc = _service(tmp_path, delivered)
    monkeypatch.setattr(hooks, "caller_slug_for_session", lambda s: SESSIONS.get(s, ""))
    rid = mcp_server._submit({"op": "call", "agent": "researcher", "message": "hi",
                              "session": "dashboard:member-assistant.memory-x"}, svc.store.root)
    _drain_outbox(svc)  # pytest is not the a2a MCP server, so the real check refuses it
    res = json.loads((svc.store.results / f"{rid}.json").read_text())
    assert res["ok"] is False and "verify" in res["error"] and delivered == []


def test_reply_text_does_not_double():
    assert hooks.reply_text(["Hel", "lo"], ["Hello"]) == "Hello"
    assert hooks.reply_text(["Hel", "lo"], []) == "Hello"


def test_migrate_private_moves_once(tmp_path):
    old, new = tmp_path / "old", tmp_path / "new"
    (old / "contexts").mkdir(parents=True)
    (old / "policy.json").write_text("{}")
    assert sorted(hooks._migrate_private(old, new)) == ["contexts", "policy.json"]
    assert (new / "policy.json").exists() and not (old / "policy.json").exists()
    assert hooks._migrate_private(old, new) == []


def test_chat_body_carries_banner():
    assert hooks.chat_body("member-x", "full", "A2A · X asks · turn 1/3") == {
        "slot": "member-x", "message": "full", "banner": "A2A · X asks · turn 1/3"}
    assert "banner" not in hooks.chat_body("member-x", "full", "")


def test_route_and_started_service_share_one_instance(tmp_path):
    """The loader runs hooks.py once per hook; routes must still find the started service."""
    import importlib.util
    import sys as _sys
    import types as _types
    from pathlib import Path as _P

    src = _P(hooks.__file__)
    _types  # noqa
    pkg = _types.ModuleType("_fakeapp"); pkg.__path__ = [str(src.parent)]
    _sys.modules["_fakeapp"] = pkg
    _sys.modules["_fakeapp.core"] = _sys.modules["backend.core"]

    def load(name):
        spec = importlib.util.spec_from_file_location(f"_fakeapp.{name}", str(src.parent / f"{name}.py"))
        mod = importlib.util.module_from_spec(spec)
        _sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        return mod

    try:
        routes_copy = load("routes")            # the routes hook: imports hooks copy A
        startup_copy = load("hooks")            # on_startup: a fresh copy B of hooks.py
        assert startup_copy is not routes_copy.hooks
        svc = _service(tmp_path, [])
        startup_copy._runtime["service"] = svc  # what on_startup does
        assert routes_copy._svc() is svc
    finally:
        startup_copy._runtime.pop("service", None)
        for k in [k for k in _sys.modules if k == "_fakeapp" or k.startswith("_fakeapp.")]:
            _sys.modules.pop(k, None)


def test_stale_deliveries_are_closed_once_on_startup(tmp_path):
    import time as _t
    store = Store(tmp_path)
    store.ensure()
    store.write_context("c-old", {"pair": ["assistant", "researcher"], "turns": 1})
    old = _t.strftime("%Y-%m-%dT%H:%M:%S.000Z", _t.gmtime(_t.time() - 3600))
    rows = [{"ts": old, "op": "send", "outcome": "delivering", "caller": "assistant", "target": "researcher",
             "context": "c-old", "task": "t-old"},
            {"ts": old, "op": "send", "outcome": "delivering", "caller": "assistant", "target": "researcher",
             "context": "c-done", "task": "t-done"},
            {"ts": old, "op": "send", "outcome": "completed", "task": "t-done"}]
    store.audit_path.write_text("".join(json.dumps(r) + "\n" for r in rows))
    store.audit({"op": "send", "outcome": "delivering", "caller": "assistant", "target": "researcher",
                 "context": "c-new", "task": "t-new"})  # fresh: may still be running
    assert hooks.close_stale_deliveries(store) == 1
    last = json.loads(store.audit_path.read_text().splitlines()[-1])
    assert last["task"] == "t-old" and last["outcome"] == "error" and last["reason"] == "stale"
    assert store.read_context("c-old")["turns"] == 0
    assert hooks.close_stale_deliveries(store) == 0  # once


def test_refused_send_task_and_old_stuck_tasks_end_failed(tmp_path):
    from backend import core
    store = Store(tmp_path)
    store.ensure()
    store.save_policy(Policy.from_dict({"allow": {"assistant": ["researcher"]}}))

    async def refuse(slug, text, banner=""):
        raise core.A2AError(-32050, "Research Bot has no chat yet; ask your owner to open it once")

    svc = A2AService(store, Gateway(resolve_target=BOTS.get, deliver=refuse, scrub=lambda s: s))
    try:
        asyncio.run(svc.send("assistant", "Assistant", "researcher", "q"))
    except core.A2AError:
        pass
    states = {t["id"]: t["status"]["state"] for t in store.tasks()}
    assert list(states.values()) == ["TASK_STATE_FAILED"]  # never left "In progress"
    # A 0.5.0 leftover: WORKING task file with an error audit row is closed at startup.
    stuck = core.make_task("t-stuck", "c1", core.STATE_WORKING, "Asking...")
    store.save_task({**stuck, "_caller": "assistant", "_target": "researcher"})
    store.audit({"op": "send", "outcome": "delivering", "task": "t-stuck", "context": "c1"})
    store.audit({"op": "send", "outcome": "error", "task": "t-stuck", "context": "c1", "error": "no chat yet"})
    assert hooks.close_stale_deliveries(store) == 1
    assert store.load_task("t-stuck")["status"]["state"] == "TASK_STATE_FAILED"
    assert hooks.close_stale_deliveries(store) == 0
