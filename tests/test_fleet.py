"""Fleet (0.7): a2a between the owner's own crews.

Two halves:

- With NO core seam (every Kiro Crew so far) every peer call, outbound or inbound, is
  refused with "peer seam not available" and nothing is sent or delivered.
- With a fake seam that stands in for the core RFC ("app peer calls"), a hub and a
  remote service talk in-process: policy pairs on both ends, the smaller turn cap
  wins, depth 1, and the remote takes the hub's identity from the claim only.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import peers, routes  # noqa: E402
from backend.core import A2AError, A2AService, Gateway, Policy, Store  # noqa: E402

HUB_GW = "gw-hub-1"


def run(coro):
    return asyncio.run(coro)


class Host:
    def __init__(self, bots, reply="answer from the remote Bot", peers_sdk=None):
        self.bots = bots
        self.reply = reply
        self.delivered: list[tuple[str, str]] = []
        self.peers = peers_sdk
        self.on_deliver = None

    async def deliver(self, slug, text, banner=""):
        self.delivered.append((slug, text))
        if self.on_deliver:
            await self.on_deliver(slug)
        return self.reply


def make(tmp_path, name, bots, policy=None, peers_sdk=None):
    store = Store(tmp_path / name)
    store.ensure()
    if policy is not None:
        store.save_policy(Policy.from_dict(policy))
    host = Host(bots, peers_sdk=peers_sdk)
    gw = Gateway(resolve_target=bots.get, deliver=host.deliver, scrub=lambda s: s.replace("ghp_SECRET", "[REDACTED]"),
                 peers=peers_sdk)
    return A2AService(store, gw), host


class Bridge:
    """Stands in for the core seam: ``ctx.peers`` on the hub, the token claim on the remote.

    It carries a call to the remote's ``/peer/*`` handling with the claim the core would
    set (``gateway_id`` of the hub), and nothing the hub's body says about identity.
    """

    gateway_id = HUB_GW

    def __init__(self):
        self.remote = None
        self.calls: list[tuple] = []

    async def request(self, instance_id, method, subpath, *, json=None, params=None, timeout=None):
        self.calls.append((instance_id, method, subpath, json, params))
        if instance_id != "inst-dev":
            return {"status": 404, "body": {"error": "no such instance"}}
        if method == "POST" and subpath.startswith("rpc/"):
            body = await self.remote.handle_peer_rpc(HUB_GW, subpath[4:], __import__("json").dumps(json))
            return {"status": 200, "body": body}
        if method == "GET" and subpath == "roster":
            slugs = self.remote.peer_roster(HUB_GW, (params or {}).get("caller", ""))
            return {"status": 200, "body": {"agents": [{"id": s, "name": s} for s in slugs]}}
        return {"status": 403, "body": {"error": "path outside the peer surface"}}


HUB_POLICY = {"allow": {}, "fleet": {"crews": {"dev": "inst-dev"}, "allow_out": {"alice": ["dev/alice"]}}}
REMOTE_POLICY = {"allow": {}, "fleet": {"allow_in": {f"{HUB_GW}/alice": ["alice"]}}}


def pair(tmp_path, hub_policy=HUB_POLICY, remote_policy=REMOTE_POLICY):
    bridge = Bridge()
    hub, hub_host = make(tmp_path, "hub", {"alice": "Alice"}, hub_policy, peers_sdk=bridge)
    remote, remote_host = make(tmp_path, "remote", {"alice": "Alice", "other": "Other"}, remote_policy,
                               peers_sdk=bridge)
    bridge.remote = remote
    return hub, remote, bridge, remote_host


def text_of(task):
    parts = (task.get("artifacts") or [{}])[0].get("parts") or task["status"]["message"]["parts"]
    return parts[0]["text"]


def audit(svc):
    return [json.loads(x) for x in svc.store.audit_path.read_text().splitlines()]


# ------------------------------------------------------------------ naming and policy


def test_names_and_fleet_policy_are_validated():
    assert peers.split_remote("dev/alice") == ("dev", "alice")
    for bad in ("alice", "dev/", "/alice", "a/b/c", "Dev/alice", "dev/Alice", "dev/../x", 7):
        assert peers.split_remote(bad) is None
    fleet = peers.clean_fleet({
        "crews": {"dev": "inst-dev", "BAD": "x", "ok2": "has space"},
        "allow_out": {"alice": ["dev/alice", "alice", "x/y/z"], "Bad": ["dev/alice"]},
        "allow_in": {f"{HUB_GW}/alice": ["alice", "Not A Slug"], "no-slash": ["alice"]},
        "max_turns": 99,
    })
    assert fleet == {"crews": {"dev": "inst-dev"}, "allow_out": {"alice": ["dev/alice"]},
                     "allow_in": {f"{HUB_GW}/alice": ["alice"]}, "max_turns": None}


def test_a_peer_identity_is_granted_only_through_allow_in():
    # A "peer:" key in the ordinary allow map is dropped: only fleet.allow_in admits a peer.
    p = Policy.from_dict({"allow": {f"peer:{HUB_GW}/alice": ["alice"]}})
    assert p.allow == {} and not p.permits(f"peer:{HUB_GW}/alice", "alice")
    p = Policy.from_dict(REMOTE_POLICY)
    assert p.permits(f"peer:{HUB_GW}/alice", "alice")
    assert not p.permits(f"peer:{HUB_GW}/alice", "other")
    assert not p.permits("peer:gw-someone-else/alice", "alice")
    assert Policy.from_dict(p.to_dict()).fleet == p.fleet  # survives the page's save round trip


def test_caps_take_the_smallest():
    assert peers.effective_cap(5, None, 0) == 5
    assert peers.effective_cap(5, 3, 0) == 3
    assert peers.effective_cap(5, 3, 2) == 2
    assert peers.effective_cap(2, 8, 9) == 2


# ------------------------------------------------------------- no core seam: fail closed


def test_without_the_seam_every_peer_call_is_refused_and_nothing_is_sent(tmp_path):
    svc, host = make(tmp_path, "hub", {"alice": "Alice"}, HUB_POLICY)  # policy allows it; no seam
    assert not svc.fleet_ready()
    for coro in (svc.send_remote("alice", "Alice", "dev/alice", "hi"), svc.remote_card("alice", "dev/alice")):
        with pytest.raises(A2AError) as err:
            run(coro)
        assert err.value.reason == peers.SEAM_UNAVAILABLE and "peer seam not available" in err.value.message
    # Same answer when the policy would refuse: the seam check comes first and leaks nothing.
    with pytest.raises(A2AError) as err:
        run(svc.send_remote("alice", "Alice", "dev/nobody", "hi"))
    assert err.value.reason == peers.SEAM_UNAVAILABLE
    with pytest.raises(A2AError) as err:
        run(svc.orchestrate("alice", "Alice", ["dev/alice"], "hi"))
    assert err.value.reason == peers.SEAM_UNAVAILABLE
    assert host.delivered == []
    rows = audit(svc)
    assert [r["reason"] for r in rows if r["op"] == "peer_send"] == ["peer_seam_unavailable"] * 3
    assert [r["reason"] for r in rows if r["op"] == "orchestrate"] == ["peer_seam_unavailable"]
    assert svc.list_info("alice")["remote"] == ["dev/alice"] and svc.list_info("alice")["fleet_ready"] is False


def test_verified_peer_reads_only_the_core_claim():
    class Req(dict):
        pass

    good = Req(peer={"gateway_id": HUB_GW, "app": "a2a"})
    assert peers.verified_peer(good, None) == ""  # no seam on this host: no claim is believed
    assert peers.verified_peer(good, Bridge()) == HUB_GW
    assert peers.verified_peer(Req(peer={"gateway_id": HUB_GW, "app": "other"}), Bridge()) == ""
    assert peers.verified_peer(Req(peer={"gateway_id": "bad id!", "app": "a2a"}), Bridge()) == ""
    assert peers.verified_peer(Req(peer="gw-hub-1"), Bridge()) == ""
    assert peers.verified_peer(Req(app="", user="owner"), Bridge()) == ""  # the owner is not a peer


class _Req(dict):
    def __init__(self, body=None, query=None, match=None, **claims):
        super().__init__(**claims)
        self._body = json.dumps(body or {}).encode()
        self.content_length = len(self._body)
        self.query = query or {}
        self.match_info = match or {}

    async def read(self):
        return self._body


class _Ctx:
    def __init__(self, peers_sdk=None):
        self.peers = peers_sdk

    async def require_owner(self, request, op):
        return None


def test_peer_routes_refuse_everyone_without_the_seam(tmp_path, monkeypatch):
    svc, host = make(tmp_path, "remote", {"alice": "Alice"}, REMOTE_POLICY)
    monkeypatch.setattr(routes.hooks, "service", lambda: svc)
    body = {"jsonrpc": "2.0", "id": 1, "method": "message/send",
            "params": {"message": {"role": "ROLE_USER", "parts": [{"text": "hi"}]},
                       "metadata": {peers.META_KEY: {"caller": "alice"}}}}
    callers = [
        _Req(body, match={"slug": "alice"}, app="", user="owner"),  # the owner's own token
        _Req(body, match={"slug": "alice"}, app="other-app"),  # another app's token
        _Req(body, match={"slug": "alice"}, peer={"gateway_id": HUB_GW, "app": "a2a"}),  # forged claim
    ]
    for req in callers:
        resp = run(routes.post_peer_rpc(req, _Ctx()))
        assert resp.status == 403 and json.loads(resp.body)["code"] == "peer_seam_unavailable"
        resp = run(routes.get_peer_roster(_Req(query={"caller": "alice"}, **{k: v for k, v in req.items()}), _Ctx()))
        assert resp.status == 403
    assert host.delivered == []


def test_peer_routes_with_the_seam_still_need_the_claim(tmp_path, monkeypatch):
    svc, host = make(tmp_path, "remote", {"alice": "Alice"}, REMOTE_POLICY, peers_sdk=Bridge())
    monkeypatch.setattr(routes.hooks, "service", lambda: svc)
    monkeypatch.setattr(routes, "card_for", lambda slug: {"name": slug})
    resp = run(routes.get_peer_roster(_Req(query={"caller": "alice"}, app="", user="owner"), _Ctx(Bridge())))
    assert resp.status == 403 and json.loads(resp.body)["code"] == "peer_identity_required"
    claim = {"peer": {"gateway_id": HUB_GW, "app": "a2a"}}
    resp = run(routes.get_peer_roster(_Req(query={"caller": "alice"}, **claim), _Ctx(Bridge())))
    assert [a["id"] for a in json.loads(resp.body)["agents"]] == ["alice"]
    resp = run(routes.get_peer_roster(_Req(query={"caller": "stranger"}, **claim), _Ctx(Bridge())))
    assert json.loads(resp.body)["agents"] == []


def test_fleet_view_says_why_peer_calls_are_off(tmp_path):
    svc, _ = make(tmp_path, "hub", {"alice": "Alice"}, HUB_POLICY)
    view = routes.fleet_view(svc, [{"op": "peer_send", "outcome": "denied"}, {"op": "send"}])
    assert view["seam"] is False and "peer seam not available" in view["seam_message"]
    assert view["fleet"]["crews"] == {"dev": "inst-dev"} and len(view["rows"]) == 1


# --------------------------------------------------- with a stand-in seam (the RFC's shape)


def test_alice_asks_alice_on_the_other_crew(tmp_path):
    hub, remote, bridge, remote_host = pair(tmp_path)
    task = run(hub.send_remote("alice", "Alice", "dev/alice", "status? token ghp_SECRET"))
    assert task["status"]["state"] == "TASK_STATE_COMPLETED" and text_of(task) == "answer from the remote Bot"
    inst, method, subpath, body, _ = bridge.calls[0]
    assert (inst, method, subpath) == ("inst-dev", "POST", "rpc/alice")
    assert "[REDACTED]" in body["params"]["message"]["parts"][0]["text"]  # scrubbed before it left
    # On the remote the turn ran as the hub's identity from the claim, fenced as peer text.
    slug, framed = remote_host.delivered[0]
    assert slug == "alice" and "untrusted data" in framed
    rows = audit(remote)
    assert any(r["op"] == "peer_receive" and r["caller"] == f"peer:{HUB_GW}/alice" for r in rows)
    assert any(r["op"] == "send" and r["outcome"] == "completed" and r["caller"] == f"peer:{HUB_GW}/alice"
               for r in rows)
    assert any(r["op"] == "peer_send" and r["outcome"] == "completed" for r in audit(hub))
    # Both ends logged the same context.
    ctx = task["contextId"]
    assert any(r.get("context") == ctx for r in rows)
    assert run(hub.remote_card("alice", "dev/alice"))["id"] == "alice"


def test_both_halves_of_the_pair_are_needed(tmp_path):
    # Hub allows, remote does not.
    hub, remote, _, remote_host = pair(tmp_path, remote_policy={"allow": {}})
    task = run(hub.send_remote("alice", "Alice", "dev/alice", "hi"))
    assert task["status"]["state"] == "TASK_STATE_REJECTED" and "not permitted" in text_of(task)
    assert remote_host.delivered == []
    # Remote allows, hub does not.
    hub, remote, bridge, remote_host = pair(tmp_path / "b", hub_policy={"fleet": {"crews": {"dev": "inst-dev"}}})
    with pytest.raises(A2AError) as err:
        run(hub.send_remote("alice", "Alice", "dev/alice", "hi"))
    assert "not permitted" in err.value.message and bridge.calls == [] and remote_host.delivered == []


def test_the_remote_ignores_identity_in_the_body(tmp_path):
    hub, remote, _, remote_host = pair(tmp_path)
    raw = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "message/send",
                      "params": {"message": {"role": "ROLE_USER", "parts": [{"text": "hi"}]},
                                 "metadata": {peers.META_KEY: {"caller": "alice", "gateway_id": "gw-hub-1"}}}})
    # A different (verified) hub claiming the same slug in its body is not gw-hub-1's alice.
    out = run(remote.handle_peer_rpc("gw-someone-else", "alice", raw))
    assert "error" in out and remote_host.delivered == []


def test_answer_only_methods(tmp_path):
    _, remote, _, _ = pair(tmp_path)
    for method in ("tasks/cancel", "tasks/list"):
        raw = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                          "params": {"metadata": {peers.META_KEY: {"caller": "alice"}}}})
        assert run(remote.handle_peer_rpc(HUB_GW, "alice", raw))["error"]["code"] == -32601


def test_the_smaller_turn_cap_wins(tmp_path):
    # Hub caps the pair at 2 turns (fleet.max_turns), the remote allows 5: the hub's 2 wins.
    hub_policy = {**HUB_POLICY, "fleet": {**HUB_POLICY["fleet"], "max_turns": 2}}
    hub, remote, bridge, remote_host = pair(tmp_path, hub_policy=hub_policy)
    t1 = run(hub.send_remote("alice", "Alice", "dev/alice", "one"))
    ctx = t1["contextId"]
    run(hub.send_remote("alice", "Alice", "dev/alice", "two", ctx))
    t3 = run(hub.send_remote("alice", "Alice", "dev/alice", "three", ctx))
    assert t3["status"]["state"] == "TASK_STATE_REJECTED" and len(remote_host.delivered) == 2
    assert bridge.calls[0][3]["params"]["metadata"][peers.META_KEY]["max_turns"] == 2
    # The remote caps at 1, the hub allows 5: the remote's 1 wins.
    remote_policy = {"allow": {}, "fleet": {**REMOTE_POLICY["fleet"], "max_turns": 1}}
    hub, remote, bridge, remote_host = pair(tmp_path / "b", remote_policy=remote_policy)
    t1 = run(hub.send_remote("alice", "Alice", "dev/alice", "one"))
    t2 = run(hub.send_remote("alice", "Alice", "dev/alice", "two", t1["contextId"]))
    assert t2["status"]["state"] == "TASK_STATE_REJECTED" and "limit of 1" in text_of(t2)
    assert len(remote_host.delivered) == 1


def test_depth_one_a_bot_answering_a_peer_cannot_call_another_crew(tmp_path):
    hub, remote, bridge, remote_host = pair(tmp_path)
    # The remote's alice also has an outbound pair, to a third crew.
    remote.store.save_policy(Policy.from_dict({"fleet": {**REMOTE_POLICY["fleet"], "crews": {"third": "inst-3"},
                                                          "allow_out": {"alice": ["third/x"]}}}))
    seen = {}

    async def call_out(slug):
        try:
            await remote.send_remote(slug, "Alice", "third/x", "relay this")
        except A2AError as err:
            seen["err"] = err.message

    remote_host.on_deliver = call_out
    task = run(hub.send_remote("alice", "Alice", "dev/alice", "hi"))
    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert "may not start a call of its own" in seen["err"]
    assert not any(c[0] == "inst-3" for c in bridge.calls)


def test_a_refusing_or_unreachable_crew_gives_the_turn_back(tmp_path):
    hub, _, bridge, _ = pair(tmp_path, hub_policy={"fleet": {"crews": {"dev": "inst-gone"},
                                                             "allow_out": {"alice": ["dev/alice"]}}})
    with pytest.raises(A2AError) as err:
        run(hub.send_remote("alice", "Alice", "dev/alice", "hi", "ctx1"))
    assert err.value.reason == "PEER_REFUSED"
    assert hub.store.read_context("ctx1")["turns"] == 0
