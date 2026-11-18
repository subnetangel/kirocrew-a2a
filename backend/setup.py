"""One-click setup and upgrade health: what each Bot's spec needs, as a plan.

Pure logic, no Kiro Crew imports, so it is unit-testable on its own. This module
only READS: ``routes.py`` hands it each Bot's spec (read-only) and returns the
plan to the owner's page. The page applies the plan itself, with the owner's own
signed-in session, through the host's capability preview and commit
(``POST /api/agents/b64/{name}/capabilities/preview`` then ``PUT`` with the
``preview_token``), the same calls the dashboard's change cards make. Nothing
here writes a spec, and nothing here is ever sent with the app token.

Why a stable command: kiro-cli runs the a2a MCP server with whatever ``command``
the Bot's spec names. A spec that names the gateway's versioned runtime Python
(``~/.local/state/kirocrew-internal/runtime/<version>/...``) breaks on the next
Kiro Crew upgrade, because that folder is removed. ``mcp_server.py`` is stdlib
only and runs on Python 3.9+, so the host's system ``python3`` plus the app's
installed path (``~/.kiro/crew/apps/a2a/backend/mcp_server.py``) survives upgrades.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

#: The server id kiro-cli knows a2a by in a Bot's spec (``<app>:<server>``).
SERVER_ID = "a2a:a2a"
TOOL_REF = f"@{SERVER_ID}"
#: Every tool the a2a MCP server serves (``mcp_server.TOOLS``), kept in step by a test.
#: The tools a Bot needs for a2a to work (0.4.x). Missing one is "Needs repair".
CORE_TOOLS = ("a2a_list", "a2a_discover", "a2a_call", "a2a_orchestrate", "a2a_result", "a2a_history")
#: Tools added since. Missing one is "Update available": the Bot still works.
TOOL_NAMES = CORE_TOOLS + ("a2a_cancel", "a2a_tasks")
#: System interpreters, in order. Never the gateway's own versioned runtime.
PYTHON_CANDIDATES = ("/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3")
#: A path segment that marks the gateway's private, per-version runtime.
_FRAGILE_MARKS = ("/kirocrew-internal/runtime/", "/kirocrew-internal/")


def is_fragile(command: str) -> bool:
    """Whether *command* lives under a folder a Kiro Crew upgrade removes."""
    return any(mark in (command or "") for mark in _FRAGILE_MARKS)


def stable_python(candidates: Iterable[str] = PYTHON_CANDIDATES,
                  exists: Callable[[str], bool] = os.path.exists) -> str:
    """The first system ``python3`` on this host, or ``""`` when none is found."""
    for path in candidates:
        if not is_fragile(path) and exists(path):
            return path
    return ""


def server_script(app_dir: Path) -> str:
    return str(Path(app_dir) / "backend" / "mcp_server.py")


def stable_transport(app_dir: Path, python: str) -> dict:
    """The mcpServers entry every Bot should carry. Same keys the manifest declares."""
    return {"command": python, "args": [server_script(app_dir)], "x-kirocrew-session-label": True}


def tool_refs() -> list[str]:
    return [f"{TOOL_REF}/{name}" for name in TOOL_NAMES]


def _strs(value: Any) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def bot_health(spec: Any, transport: dict, exists: Callable[[str], bool] = os.path.exists) -> dict:
    """What one Bot's spec says about a2a, and whether it will survive an upgrade.

    ``ok`` is true only when the server is mounted with *transport* exactly (stable
    command, this app's script), the command and script exist, the server's tools
    are enabled, and every a2a tool is allowed.
    """
    spec = spec if isinstance(spec, dict) else {}
    servers = spec.get("mcpServers") if isinstance(spec.get("mcpServers"), dict) else {}
    entry = servers.get(SERVER_ID) if isinstance(servers.get(SERVER_ID), dict) else None
    command = str((entry or {}).get("command") or "")
    args = _strs((entry or {}).get("args"))
    script = args[0] if args else ""
    tools = set(_strs(spec.get("tools")))
    allowed = set(_strs(spec.get("allowedTools")))
    tools_enabled = TOOL_REF in tools or "*" in tools or f"{TOOL_REF}/*" in tools
    all_allowed = TOOL_REF in allowed or f"{TOOL_REF}/*" in allowed
    missing = [] if all_allowed else [r.rsplit("/", 1)[1] for r in tool_refs() if r not in allowed]
    newer = [n for n in missing if n not in CORE_TOOLS]
    missing = [n for n in missing if n in CORE_TOOLS]
    health = {
        "mounted": entry is not None,
        "disabled": bool((entry or {}).get("disabled")),
        "command": command,
        "script": script,
        "command_exists": bool(command) and exists(command),
        "script_exists": bool(script) and exists(script),
        "fragile": is_fragile(command),
        "this_app": bool(script) and os.path.realpath(script) == os.path.realpath(transport["args"][0]),
        "labelled": (entry or {}).get("x-kirocrew-session-label") is True,
        "tools_enabled": tools_enabled,
        "tools_missing": missing,
        "tools_newer": newer,
        "all_allowed": all_allowed,
    }
    # Any system python3 that exists is fine; the script must be this app's own copy.
    health["matches"] = (health["mounted"] and not health["disabled"] and health["command_exists"]
                         and not health["fragile"] and health["this_app"] and health["script_exists"]
                         and health["labelled"])
    health["problems"] = problems(health)
    # Tiers: "ok" is the required set only. Newer tools missing is an update, not a fault.
    health["ok"] = not health["problems"]
    health["update_available"] = health["ok"] and bool(newer)
    return health


def problems(health: dict) -> list[str]:
    """Plain-language reasons a Bot's a2a mount is not healthy, worst first."""
    out = []
    if not health["mounted"]:
        out.append("a2a tools are not mounted")
    else:
        if health["disabled"]:
            out.append("the a2a server is switched off")
        if not health["command_exists"]:
            out.append(f"command not found: {health['command'] or '(none)'}")
        elif health["fragile"]:
            out.append("command is inside the Kiro Crew runtime folder, which the next upgrade deletes")
        if not health["script_exists"]:
            # Repair points the mount back at this app's own copy; if that copy is gone too,
            # the fix is the app page's Update (or Sync) button, never a command.
            out.append(f"server script not found: {health['script'] or '(none)'}. Repair points it at "
                       "this app's copy; if that is missing, press Update or Sync on the A2A app page")
        elif not health["this_app"]:
            out.append(f"runs another copy of the server: {health['script']}")
        if not health["labelled"]:
            out.append("session label is off, so a2a cannot tell which Bot is calling")
    if not health["tools_enabled"]:
        out.append("a2a tools are not enabled")
    if health["tools_missing"]:
        out.append("not allowed: " + ", ".join(health["tools_missing"]))
    return out


def _tool_ops(names: list, all_allowed: bool) -> list[dict]:
    ops = [{"section": "allowedTools", "id": f"{TOOL_REF}/{name}", "action": "set", "value": True} for name in names]
    if names and not all_allowed:
        # The server-level entry (``@a2a:a2a``, accepted by 0.13.0.1's spec schema) lets
        # tools a later a2a adds run without another heal. Per-tool entries ride along,
        # so a host whose governance strips the server entry still gets these tools.
        ops.append({"section": "allowedTools", "id": TOOL_REF, "action": "set", "value": True})
    return ops


def heal_ops(health: Optional[dict]) -> list[dict]:
    """The auto-heal for one Bot: only when it already mounts a2a correctly and the only
    drift is tools a newer a2a added. Only allowedTools a2a entries, never a mount."""
    if not health or not health.get("ok") or not health.get("tools_newer"):
        return []
    return _tool_ops(health["tools_newer"], health.get("all_allowed", False))


def repair_ops(health: dict, transport: dict) -> list[dict]:
    """The capability operations that bring one Bot to a healthy mount. ``[]`` when ok.

    The shape is the host's capability request (``agent_capabilities.validate_request``):
    ``{"section", "id", "action": "set", "value"}``.
    """
    ops: list[dict] = []
    if not health["matches"]:
        ops.append({"section": "mcpServers", "id": SERVER_ID, "action": "set", "value": dict(transport)})
    if not health["tools_enabled"]:
        ops.append({"section": "tools", "id": TOOL_REF, "action": "set", "value": True})
    ops.extend(_tool_ops(health["tools_missing"] + health.get("tools_newer", []), health.get("all_allowed", False)))
    return ops


def full_allow(bot_ids: Iterable[str], allow: Any) -> dict:
    """*allow* with every Bot allowed to ask every other Bot. Other callers are kept."""
    ids = sorted(dict.fromkeys(b for b in bot_ids if isinstance(b, str) and b))
    out = {k: sorted(v) for k, v in (allow or {}).items() if isinstance(v, (list, set, frozenset, tuple))}
    for b in ids:
        out[b] = sorted(set(out.get(b, [])) | {t for t in ids if t != b})
    return out


def missing_pairs(bot_ids: Iterable[str], allow: Any) -> list[list[str]]:
    ids = sorted(dict.fromkeys(b for b in bot_ids if isinstance(b, str) and b))
    allow = allow or {}
    return [[a, b] for a in ids for b in ids if a != b and b not in set(allow.get(a, []))]


def plan(bots: list[dict], allow: Any, transport: dict) -> dict:
    """The whole setup plan for the page: per-Bot health and ops, and the policy delta.

    *bots* rows carry ``id``, ``name``, ``agent``, ``owned`` (the Bot owns its spec
    file, so the host edits it in place) and ``spec`` (read-only, never returned).
    A Bot whose spec is not its own gets no ops: the owner sets it up from that
    Bot's Capabilities tab, which forks a shared template.
    """
    rows = []
    for b in bots:
        owned = bool(b.get("owned"))
        health = bot_health(b.get("spec"), transport, b.get("exists") or os.path.exists) if owned else None
        rows.append({
            "id": b["id"], "name": b.get("name") or b["id"], "agent": b.get("agent") or "",
            "owned": owned, "unreadable": bool(b.get("unreadable")), "chat": b.get("chat", True) is not False,
            "health": health,
            "ops": repair_ops(health, transport) if health else [],
            "heal": heal_ops(health),
        })
    ids = [b["id"] for b in bots]
    gaps = missing_pairs(ids, allow)
    return {
        "transport": transport,
        "bots": rows,
        "policy": {"missing_pairs": gaps, "complete": not gaps, "proposed_allow": full_allow(ids, allow)},
        # A Bot whose settings could not be read is unknown, never done.
        "mounts_complete": all(not r["unreadable"] and (r["health"] is None or r["health"]["ok"]) for r in rows),
    }
