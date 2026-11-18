"""Host check: every route under ``/api/agents/b64`` (the one host prefix this app's
manifest adds to ``permissions.api``) refuses the app's own token.

``permissions.api`` scopes only the app token (``token_auth_app_scope.app_token_path_allowed``);
the owner's session bypasses it. So the prefix lets the app token reach these routes, and
what keeps it out is each handler's owner gate (``require_owner_dashboard_request`` ->
``is_owner_dashboard_request``, False whenever ``request["app"] != ""``). This test calls
every handler registered under the prefix as the app token and expects 403 ``owner_only``.

Needs the Kiro Crew runtime on the path; skipped elsewhere (for example upstream CI).
"""

from __future__ import annotations

import asyncio
import base64
import types

import pytest

try:
    from kiro_crew.dashboard.routes import agents as routes_agents
except ImportError as exc:  # no runtime, or a runtime whose native libs this interpreter cannot load
    pytest.skip(f"Kiro Crew runtime not importable here: {exc}", allow_module_level=True)


def test_every_b64_agent_route_refuses_the_app_token():
    from aiohttp import web
    from aiohttp.test_utils import make_mocked_request

    app = web.Application()
    routes_agents.register(app)
    app["state"] = types.SimpleNamespace(owner_id="", push_refresh=lambda *a: None, sessions=None)
    seg = base64.urlsafe_b64encode(b"Assistant").rstrip(b"=").decode()
    seen = []

    async def go():
        for route in app.router.routes():
            info = route.get_info()
            path = info.get("formatter") or info.get("path") or ""
            if not path.startswith("/api/agents/b64/"):
                continue
            req = make_mocked_request(route.method, path.replace("{name_b64}", seg), app=app,
                                      match_info={"name_b64": seg})
            req["app"] = "a2a"  # what the gateway's token middleware sets for this app's token
            req["user"] = "app:a2a"
            resp = await route.handler(req)
            seen.append((route.method, path, resp.status))

    asyncio.run(go())
    assert seen, "no /api/agents/b64 routes found on this host"
    assert all(status == 403 for _, _, status in seen), [s for s in seen if s[2] != 403]
