"""One-click setup, upgrade health and repair: the plan, the stable command, and the
rule that owner-only host APIs are only ever called from the owner's page."""

from __future__ import annotations

import ast
import json
import asyncio
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import mcp_server, routes, setup  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
APP = Path("/home/example/.kiro/crew/apps/a2a")
SCRIPT = str(APP / "backend" / "mcp_server.py")
FRAGILE = "/home/example/.local/state/kirocrew-internal/runtime/0.13.0.1/python3.12/bin/python3.12"
STABLE = setup.stable_transport(APP, "/usr/bin/python3")


def _exists(*present):
    return lambda p: p in present


def _spec(command=STABLE["command"], script=SCRIPT, tools=("@a2a:a2a",), allowed=None, label=True):
    entry = {"command": command, "args": [script]}
    if label:
        entry["x-kirocrew-session-label"] = True
    return {"name": "x", "mcpServers": {"a2a:a2a": entry}, "tools": list(tools),
            "allowedTools": setup.tool_refs() if allowed is None else list(allowed)}


def test_tool_names_match_the_server():
    assert set(setup.TOOL_NAMES) == set(mcp_server.TOOLS)


def test_stable_command_is_system_python_and_the_installed_script():
    assert STABLE == {"command": "/usr/bin/python3", "args": [SCRIPT], "x-kirocrew-session-label": True}
    assert setup.stable_python(exists=_exists("/usr/bin/python3")) == "/usr/bin/python3"
    assert setup.stable_python(exists=_exists("/opt/homebrew/bin/python3")) == "/opt/homebrew/bin/python3"
    # The gateway's own runtime is never offered, even when it is the only python found.
    assert setup.stable_python(candidates=(FRAGILE,), exists=lambda p: True) == ""
    assert setup.is_fragile(FRAGILE) and not setup.is_fragile("/usr/bin/python3")


def test_healthy_bot_needs_nothing():
    h = setup.bot_health(_spec(), STABLE, _exists("/usr/bin/python3", SCRIPT))
    assert h["ok"] and h["problems"] == []
    assert setup.repair_ops(h, STABLE) == []


def test_repair_detects_a_missing_command_path():
    # The runtime folder an upgrade deleted: the command no longer exists.
    h = setup.bot_health(_spec(command=FRAGILE), STABLE, _exists(SCRIPT))
    assert not h["ok"] and not h["command_exists"]
    assert any("command not found" in p for p in h["problems"])
    ops = setup.repair_ops(h, STABLE)
    assert ops[0] == {"section": "mcpServers", "id": "a2a:a2a", "action": "set", "value": STABLE}


def test_fragile_command_that_still_exists_is_flagged_before_the_upgrade():
    h = setup.bot_health(_spec(command=FRAGILE), STABLE, _exists(FRAGILE, SCRIPT))
    assert h["command_exists"] and h["fragile"] and not h["ok"]
    assert any("next upgrade deletes" in p for p in h["problems"])
    assert setup.repair_ops(h, STABLE)[0]["value"]["command"] == "/usr/bin/python3"


def test_missing_tools_and_mount_build_every_op():
    h = setup.bot_health({"name": "x"}, STABLE, _exists("/usr/bin/python3", SCRIPT))
    ops = setup.repair_ops(h, STABLE)
    assert [o["section"] for o in ops] == ["mcpServers", "tools"] + ["allowedTools"] * (len(setup.TOOL_NAMES) + 1)
    assert {o["id"] for o in ops if o["section"] == "allowedTools"} == set(setup.tool_refs()) | {"@a2a:a2a"}
    assert all(o["action"] == "set" and set(o) == {"section", "id", "action", "value"} for o in ops)


def test_old_tool_list_gets_only_the_missing_tools():
    old = [f"@a2a:a2a/{n}" for n in ("a2a_list", "a2a_discover", "a2a_call", "a2a_history")]
    h = setup.bot_health(_spec(allowed=old), STABLE, _exists("/usr/bin/python3", SCRIPT))
    assert h["tools_missing"] == ["a2a_orchestrate", "a2a_result"] and not h["ok"]
    assert h["tools_newer"] == ["a2a_cancel", "a2a_tasks"]
    ids = [o["id"] for o in setup.repair_ops(h, STABLE)]
    assert ids == [f"@a2a:a2a/{n}" for n in ("a2a_orchestrate", "a2a_result", "a2a_cancel", "a2a_tasks")] + ["@a2a:a2a"]


def test_label_off_or_other_copy_is_repaired():
    h = setup.bot_health(_spec(label=False), STABLE, _exists("/usr/bin/python3", SCRIPT))
    assert any("session label" in p for p in h["problems"]) and setup.repair_ops(h, STABLE)
    other = "/home/example/dev/a2a/backend/mcp_server.py"
    h = setup.bot_health(_spec(script=other), STABLE, _exists("/usr/bin/python3", other))
    assert any("another copy" in p for p in h["problems"])


def test_plan_allows_everyone_and_keeps_other_callers():
    bots = [
        {"id": "assistant", "name": "Assistant", "agent": "Assistant", "owned": True,
         "spec": _spec(command=FRAGILE), "exists": _exists(SCRIPT)},
        {"id": "researcher", "name": "Research Bot", "agent": "researcher", "owned": True,
         "spec": _spec(), "exists": _exists("/usr/bin/python3", SCRIPT)},
        {"id": "writer", "name": "Writer", "agent": "writer", "owned": False, "spec": None},
    ]
    allow = {"assistant": ["researcher"], "owner": ["writer"]}
    p = setup.plan(bots, allow, STABLE)
    assert p["policy"]["proposed_allow"] == {
        "assistant": ["researcher", "writer"], "researcher": ["assistant", "writer"],
        "writer": ["assistant", "researcher"], "owner": ["writer"]}
    assert ["assistant", "writer"] in p["policy"]["missing_pairs"] and not p["policy"]["complete"]
    rows = {r["id"]: r for r in p["bots"]}
    assert rows["assistant"]["ops"] and not rows["researcher"]["ops"]
    assert rows["writer"]["health"] is None and rows["writer"]["ops"] == []  # not its own spec: no ops
    assert not p["mounts_complete"]
    assert "spec" not in rows["assistant"]  # the spec itself never leaves the gateway


def test_full_allow_is_complete():
    ids = ["a", "b", "c"]
    assert setup.missing_pairs(ids, setup.full_allow(ids, {})) == []


def test_setup_route_is_owner_only_and_drops_mounts_without_python(monkeypatch):
    class Req(dict):
        def __init__(self, app=""):
            super().__init__()
            if app:
                self["app"] = app

    class Ctx:
        def __init__(self, owner):
            self.owner = owner

        async def require_owner(self, request, op):
            from aiohttp import web
            return None if self.owner else web.json_response({"error": "owner"}, status=403)

    async def go():
        assert (await routes.get_setup(Req(app="a2a"), Ctx(True))).status == 403  # the app's own token
        assert (await routes.get_setup(Req(), Ctx(False))).status == 403
    asyncio.run(go())

    monkeypatch.setattr(routes, "_all_bots", lambda: [{"id": "assistant", "name": "Assistant", "agent": "Assistant"}])
    monkeypatch.setattr(routes.hooks, "read_bot_spec", lambda name: (True, {"name": name}))
    monkeypatch.setattr(routes.hooks, "python_runs_server", lambda py: False)
    view = routes._setup_view({})
    assert view["bots"][0]["ops"] and all(o["section"] != "mcpServers" for o in view["bots"][0]["ops"])
    assert view["version"] == routes._app_version()


# --------------------------------------------- owner APIs never ride the app token

_OWNER_PATHS = re.compile(r"/api/agents|bot-grants|/capabilities")


def _code_strings(path: Path) -> list[str]:
    """String literals in *path* that are not docstrings."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docs = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
                docs.add(id(first.value))
    return [n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in docs]


def test_backend_never_calls_owner_apis():
    # The backend holds the app token; the host's capability and bot-grant routes are
    # owner-only. No backend code may name them, so they can only come from the page.
    for path in (ROOT / "backend").glob("*.py"):
        hits = [s for s in _code_strings(path) if _OWNER_PATHS.search(s)]
        assert not hits, f"{path.name} names an owner-only API: {hits}"


def test_page_calls_owner_apis_only_through_the_owner_session():
    ui = sorted((ROOT / "ui").rglob("*.mjs"))
    assert ui
    for path in ui:
        src = path.read_text(encoding="utf-8")
        # No raw fetch, no hand-made credentials: every request goes through the host SDK's
        # useAppApi(), which carries the signed-in owner's session and the manifest scope.
        assert not re.search(r"\bfetch\s*\(", src), f"{path.name} calls fetch() directly"
        assert not re.search(r"Authorization|X-KiroCrew-Capability|app_token|mc_token", src), path.name
    client = (ROOT / "ui" / "lib" / "api.mjs").read_text(encoding="utf-8")
    assert "useAppApi" in client


def test_page_modules_parse_and_their_logic_tests_pass():
    import shutil
    import subprocess

    import pytest

    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    for path in sorted((ROOT / "ui").rglob("*.mjs")):
        out = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
        assert out.returncode == 0, f"{path.name}: {out.stderr}"
    out = subprocess.run([node, "--test", str(ROOT / "tests" / "ui.test.mjs")], capture_output=True, text=True, cwd=ROOT)
    assert out.returncode == 0, out.stdout[-2000:] + out.stderr[-2000:]


# ------------------------------------------------------------ Bots with no chat yet

def test_a_bot_with_no_chat_gets_a_clear_message_not_a_raw_404(monkeypatch):
    from backend import hooks

    monkeypatch.setattr(hooks, "bot_name", lambda slug: "Designer" if slug == "designer" else None)
    msg = hooks.refusal_message("designer", 404, '{"error": "not found", "code": "slot_not_found"}')
    assert msg == "Designer has no chat yet; ask your owner to open Designer's chat once, then try again."
    assert "403" in hooks.refusal_message("designer", 403, '{"error": "owner only"}')  # other refusals unchanged

    # No thread binding at all: the same words, before anything is sent.
    monkeypatch.setattr(hooks, "thread_key", lambda slug: "")

    class Ctx:
        pass

    with __import__("pytest").raises(hooks.A2AError, match="Designer has no chat yet"):
        asyncio.run(hooks._deliver(Ctx(), "designer", "hi"))


def test_setup_lists_bots_with_no_chat_apart(monkeypatch):
    monkeypatch.setattr(routes, "_all_bots", lambda: [
        {"id": "assistant", "name": "Assistant", "agent": "Assistant", "chat": True},
        {"id": "designer", "name": "Designer", "agent": "designer", "chat": False}])
    monkeypatch.setattr(routes.hooks, "read_bot_spec", lambda name: (True, {"name": name}))
    monkeypatch.setattr(routes.hooks, "python_runs_server", lambda py: True)
    view = routes._setup_view({})
    # A Bot with no chat is listed apart AND still set up: its mount and pairs are in the plan.
    assert view["no_chat"] == [{"id": "designer", "name": "Designer", "agent": "designer"}]
    rows = {b["id"]: b for b in view["bots"]}
    assert set(rows) == {"assistant", "designer"} and rows["designer"]["chat"] is False
    assert rows["designer"]["ops"], "a no-chat Bot that owns its settings still gets its tools"
    assert ["assistant", "designer"] in view["policy"]["missing_pairs"]
    assert not view["mounts_complete"]


# ------------------------------------------------------------- static layout guards

def _css_rules(text: str):
    """(selector, body) for each plain rule, nested @-blocks included. Comments dropped."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return [(sel.strip(), body) for sel, body in re.findall(r"([^{}@;]+)\{([^{}]*)\}", text)]


def test_every_size_container_has_an_explicit_width():
    # Size containment (container / container-type: inline-size | size) makes an element
    # ignore its content when sizing. Without an explicit width it shrinks to its minimum
    # inside a host that centres it: the 0.4.0 page collapsed to about 160 px this way.
    css = (ROOT / "ui" / "a2a.css").read_text(encoding="utf-8")
    hits = 0
    for sel, body in _css_rules(css):
        decl = {k.strip(): v.strip() for k, _, v in (d.partition(":") for d in body.split(";")) if k.strip()}
        kind = decl.get("container-type") or decl.get("container", "").split("/")[-1].strip()
        if kind in ("inline-size", "size"):
            hits += 1
            assert "width" in decl or "inline-size" in decl, f"{sel} sets container {kind!r} with no width"
    assert hits, "expected the page root to be a size container"


def test_dialog_has_an_explicit_width():
    css = (ROOT / "ui" / "a2a.css").read_text(encoding="utf-8")
    body = next(b for s, b in _css_rules(css) if s == ".a2a-dialog")
    assert re.search(r"(^|;)\s*width\s*:\s*min\(", body), ".a2a-dialog needs width: min(..., 100% - 2rem)"


def test_closed_chat_is_listed_apart_until_a_send_succeeds():
    rows = [{"op": "send", "outcome": "error", "target": "designer",
             "error": "Designer has no chat yet; ask your owner to open Designer's chat once"},
            {"op": "send", "outcome": "error", "target": "old",
             "error": "gateway refused the send (404): {\"code\": \"slot_not_found\"}"},
            {"op": "send", "outcome": "error", "target": "writer", "error": "boom"}]
    assert routes.closed_chats(rows) == {"designer", "old"}
    assert routes.closed_chats(rows + [{"op": "send", "outcome": "completed", "target": "designer"}]) == {"old"}


def test_a_bot_whose_settings_cannot_be_read_is_never_counted_done():
    bots = [{"id": "assistant", "name": "Assistant", "agent": "Assistant", "owned": False, "unreadable": True, "spec": None},
            {"id": "writer", "name": "Writer", "agent": "writer", "owned": False, "spec": None}]
    p = setup.plan(bots, {}, STABLE)
    assert not p["mounts_complete"]
    assert setup.plan(bots[1:], {}, STABLE)["mounts_complete"]  # a shared template alone is fine


def test_read_bot_spec_failure_is_unknown_not_shared():
    from backend import hooks

    # Outside the gateway the host import fails: that must read as unknown (None), not "shared".
    assert hooks.read_bot_spec("Assistant")[0] in (None, True, False)
    import sys as _s
    saved = _s.modules.get("kiro_crew.mate_capabilities")
    _s.modules["kiro_crew.mate_capabilities"] = None  # force ImportError
    try:
        assert hooks.read_bot_spec("Assistant") == (None, None)
    finally:
        if saved is None:
            _s.modules.pop("kiro_crew.mate_capabilities", None)
        else:
            _s.modules["kiro_crew.mate_capabilities"] = saved


def test_only_roster_bots_are_listed(monkeypatch):
    import types

    agents = {
        "Assistant": types.SimpleNamespace(member_id="m1", source="kirocrew", display_name=""),
        "kirocrew-worker": types.SimpleNamespace(member_id="m2", source="builtin", display_name=""),
        "auto-improvement-scout": types.SimpleNamespace(member_id="m3", source="auto-improvement", display_name=""),
        "Writer": types.SimpleNamespace(member_id="m4", source="kirocrew", display_name=""),
    }
    monkeypatch.setattr(routes.hooks, "_cfg", lambda: types.SimpleNamespace(agents=agents))
    monkeypatch.setattr(routes, "is_roster_bot", lambda name, agent: agent.source == "kirocrew")
    members = types.ModuleType("kiro_crew.members")
    members.member_slug = lambda name, cfg: name.lower()
    pkg = types.ModuleType("kiro_crew")
    pkg.members = members
    monkeypatch.setitem(sys.modules, "kiro_crew", pkg)
    monkeypatch.setitem(sys.modules, "kiro_crew.members", members)
    monkeypatch.setattr(routes.hooks, "bot_name", lambda slug: {"assistant": "Assistant", "writer": "Writer",
                                                             "kirocrew-worker": "kirocrew-worker"}.get(slug))
    monkeypatch.setattr(routes.hooks, "thread_key", lambda slug: "t" if slug == "assistant" else "")
    bots = routes._all_bots()
    assert [b["id"] for b in bots] == ["assistant", "writer"]
    assert {b["id"]: b["chat"] for b in bots} == {"assistant": True, "writer": False}


def test_is_roster_bot_uses_the_dashboards_rule(monkeypatch):
    import types
    m = types.ModuleType("kiro_crew.members")
    m.is_person_created_crewmate = lambda name, agent: name == "Assistant"
    pkg = types.ModuleType("kiro_crew")
    pkg.members = m
    monkeypatch.setitem(sys.modules, "kiro_crew", pkg)
    monkeypatch.setitem(sys.modules, "kiro_crew.members", m)
    assert routes.is_roster_bot("Assistant", None) and not routes.is_roster_bot("kirocrew-worker", None)


def test_other_agents_lists_non_roster_names_only():
    allow = {"assistant": ["writer", "kirocrew-worker"], "kirocrew-worker": ["assistant"], "owner": ["assistant"],
             "app:other": ["writer"]}
    out = routes.other_agents(allow, {"assistant", "writer"})
    assert out == [{"id": "kirocrew-worker", "pairs": 2}]


def test_panel_routes_are_owner_only(monkeypatch):
    class Req(dict):
        def __init__(self, app=""):
            super().__init__()
            self.match_info = {"slug": "assistant", "task_id": "t1"}
            self.query = {"key": "dashboard:x"}
            if app:
                self["app"] = app

    class Ctx:
        async def require_owner(self, request, op):
            from aiohttp import web
            return web.json_response({"error": "owner"}, status=403)

    async def go():
        for handler in (routes.get_session_bot, routes.get_bot_view, routes.post_cancel_task):
            assert (await handler(Req(app="a2a"), Ctx())).status == 403
            assert (await handler(Req(), Ctx())).status == 403
    asyncio.run(go())


def test_session_bot_only_names_roster_bots(monkeypatch):
    class Req(dict):
        query = {"key": "dashboard:member-x"}

    class Ctx:
        async def require_owner(self, request, op):
            return None

    monkeypatch.setattr(routes.hooks, "caller_slug_for_session", lambda key: "kirocrew-worker")
    monkeypatch.setattr(routes, "_all_bots", lambda: [{"id": "assistant"}])
    out = asyncio.run(routes.get_session_bot(Req(), Ctx()))
    assert json.loads(out.text) == {"bot": ""}
    monkeypatch.setattr(routes.hooks, "caller_slug_for_session", lambda key: "assistant")
    assert json.loads(asyncio.run(routes.get_session_bot(Req(), Ctx())).text) == {"bot": "assistant"}



# ------------------------------------------------------- 0.5.1 tiers and auto-heal

OLD_6 = [f"@a2a:a2a/{n}" for n in setup.CORE_TOOLS]


def test_newer_tools_missing_is_update_available_not_needs_repair():
    h = setup.bot_health(_spec(allowed=OLD_6), STABLE, _exists("/usr/bin/python3", SCRIPT))
    assert h["ok"] and h["update_available"] and h["problems"] == []
    assert h["tools_newer"] == ["a2a_cancel", "a2a_tasks"]


def test_server_level_entry_counts_as_every_tool():
    h = setup.bot_health(_spec(allowed=["@a2a:a2a"]), STABLE, _exists("/usr/bin/python3", SCRIPT))
    assert h["ok"] and not h["update_available"] and setup.heal_ops(h) == []


def test_heal_only_adds_newer_a2a_tools_to_a_correct_mount():
    h = setup.bot_health(_spec(allowed=OLD_6), STABLE, _exists("/usr/bin/python3", SCRIPT))
    ops = setup.heal_ops(h)
    assert {o["section"] for o in ops} == {"allowedTools"}
    assert [o["id"] for o in ops] == ["@a2a:a2a/a2a_cancel", "@a2a:a2a/a2a_tasks", "@a2a:a2a"]
    assert all(o["id"].startswith("@a2a:a2a") and o["action"] == "set" for o in ops)


def test_heal_never_touches_a_bot_without_the_server_or_with_a_fault():
    assert setup.heal_ops(setup.bot_health({"name": "x"}, STABLE, _exists("/usr/bin/python3", SCRIPT))) == []
    fragile = setup.bot_health(_spec(command=FRAGILE, allowed=OLD_6), STABLE, _exists(FRAGILE, SCRIPT))
    assert not fragile["ok"] and setup.heal_ops(fragile) == []  # that is Repair's job, with a review
    core_gap = setup.bot_health(_spec(allowed=OLD_6[:4]), STABLE, _exists("/usr/bin/python3", SCRIPT))
    assert setup.heal_ops(core_gap) == []
    assert setup.heal_ops(None) == []


def test_auto_update_setting_defaults_on_and_round_trips():
    from backend.core import Policy
    assert Policy.from_dict({}).auto_update_tools is True
    assert Policy.from_dict({"auto_update_tools": False}).to_dict()["auto_update_tools"] is False


def test_side_panel_root_scrolls_and_the_page_does_not():
    css = (ROOT / "ui" / "a2a.css").read_text(encoding="utf-8")
    body = next(b for s, b in _css_rules(css) if s == ".a2a.a2a-side")
    assert re.search(r"overflow-y\s*:\s*auto", body) and re.search(r"height\s*:\s*100%", body)
    assert re.search(r"min-height\s*:\s*0", body) and "overscroll-behavior" in body
    page = next(b for s, b in _css_rules(css) if s == ".a2a")
    assert "overflow-y" not in page  # the page keeps scrolling with the host
