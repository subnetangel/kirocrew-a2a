"""Fleet (0.7): a2a between the owner's own crews, over Kiro Crew's Remote Crew tunnel.

Pure logic, stdlib only, no Kiro Crew imports, so it is unit-testable on its own and
``core`` can import it without a cycle.

The seam this needs is NOT in Kiro Crew yet (RFC "app peer calls"). Until a core ships
it, everything here fails closed:

- Outbound: :func:`seam` finds no ``ctx.peers.request``, so every peer call is refused
  with :data:`SEAM_MESSAGE` and nothing is sent.
- Inbound: :func:`verified_peer` finds no core-set ``request["peer"]`` claim, so the
  ``/peer/*`` routes refuse every caller, the owner and other apps included.

The interface this module expects the core to provide (RFC section 4):

- ``ctx.peers.request(instance_id, method, subpath, *, json=None, params=None,
  timeout=None)`` is awaitable and returns ``{"status": int, "body": <parsed JSON or
  None>}``. It reaches only ``api/apps/<this app>/peer/<subpath>`` on that Remote Crew
  instance.
- ``ctx.peers.gateway_id`` is this gateway's own id (what a remote's owner lists).
- On the remote, the token middleware sets ``request["peer"] = {"gateway_id": <hub>,
  "app": <app name>}`` from the token's own claim. Nothing in the body can set it.

No secret, token or listener is created here. Identity comes only from the core.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional

#: The error code and text every peer call gets while the core seam is missing.
SEAM_UNAVAILABLE = "PEER_SEAM_UNAVAILABLE"
SEAM_MESSAGE = ("peer seam not available: this Kiro Crew has no app peer calls, so a2a cannot reach "
                "another crew (Fleet is off until it does: "
                "https://github.com/kirodotdev/KiroCrew/issues/40040). Nothing was sent.")
#: Inbound: a request to /peer/* that carries no core-verified peer claim.
PEER_IDENTITY_REQUIRED = "PEER_IDENTITY_REQUIRED"

APP_NAME = "a2a"
PEER_PREFIX = "peer:"
#: The metadata key the hub puts its claims under. Claims, not identity: see verified_peer.
META_KEY = "kirocrew.a2a"

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_CREW_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")


def _slug(value: object) -> bool:
    return isinstance(value, str) and bool(_SLUG_RE.match(value))


def split_remote(name: object) -> Optional[tuple[str, str]]:
    """``"dev/bob"`` -> ``("dev", "bob")``; anything else -> ``None``."""
    if not isinstance(name, str) or name.count("/") != 1:
        return None
    crew, slug = name.split("/")
    if not _CREW_RE.match(crew) or not _slug(slug):
        return None
    return crew, slug


def is_remote(name: object) -> bool:
    """Whether *name* addresses another crew (it has a ``/``), well formed or not."""
    return isinstance(name, str) and "/" in name


def peer_key(gateway_id: str, slug: str) -> str:
    """The ``allow_in`` key for a Bot on another crew: ``<hub gateway id>/<slug>``."""
    return f"{gateway_id}/{slug}"


def peer_caller(gateway_id: str, slug: str) -> str:
    """The caller identity a peer turn runs under on the remote."""
    return PEER_PREFIX + peer_key(gateway_id, slug)


def _peer_key_ok(key: object) -> bool:
    if not isinstance(key, str) or key.count("/") != 1:
        return False
    gw, slug = key.split("/")
    return bool(_ID_RE.match(gw)) and _slug(slug)


def clean_fleet(raw: Any) -> dict:
    """The owner's fleet policy, validated. Anything malformed is dropped (fail closed).

    - ``crews``: alias -> Remote Crew instance id (hub side).
    - ``allow_out``: local Bot -> ``<crew>/<slug>`` it may ask (hub side).
    - ``allow_in``: ``<hub gateway id>/<slug>`` -> local Bots it may ask (remote side).
    - ``max_turns``: optional extra cap for peer conversations, 1..10; the smaller of
      this, the local turn cap and the hub's cap wins.
    """
    raw = raw if isinstance(raw, dict) else {}
    crews_in = raw.get("crews") if isinstance(raw.get("crews"), dict) else {}
    crews = {k: v for k, v in crews_in.items()
             if isinstance(k, str) and _CREW_RE.match(k) and isinstance(v, str) and _ID_RE.match(v)}
    out_in = raw.get("allow_out") if isinstance(raw.get("allow_out"), dict) else {}
    allow_out = {}
    for caller, targets in out_in.items():
        if _slug(caller) and isinstance(targets, list):
            allow_out[caller] = sorted({t for t in targets if split_remote(t)})
    in_in = raw.get("allow_in") if isinstance(raw.get("allow_in"), dict) else {}
    allow_in = {}
    for key, targets in in_in.items():
        if _peer_key_ok(key) and isinstance(targets, list):
            allow_in[key] = sorted({t for t in targets if _slug(t)})
    turns = raw.get("max_turns")
    max_turns = turns if isinstance(turns, int) and not isinstance(turns, bool) and 1 <= turns <= 10 else None
    return {"crews": dict(sorted(crews.items())), "allow_out": dict(sorted(allow_out.items())),
            "allow_in": dict(sorted(allow_in.items())), "max_turns": max_turns}


def permits_out(fleet: dict, caller: str, name: str) -> bool:
    """Hub side: may local Bot *caller* ask ``<crew>/<slug>`` *name*?"""
    split = split_remote(name)
    return bool(split) and split[0] in fleet.get("crews", {}) and name in fleet.get("allow_out", {}).get(caller, ())


def permits_in(fleet: dict, caller: str, target: str) -> bool:
    """Remote side: may peer identity *caller* (``peer:<gw>/<slug>``) ask local *target*?"""
    if not caller.startswith(PEER_PREFIX):
        return False
    return target in fleet.get("allow_in", {}).get(caller[len(PEER_PREFIX):], ())


def seam(peers: Any) -> Any:
    """The core's peer SDK, or ``None`` when this Kiro Crew has none (every build so far)."""
    return peers if peers is not None and callable(getattr(peers, "request", None)) else None


def verified_peer(request: Any, peers: Any) -> str:
    """The calling hub's gateway id, read ONLY from the core's token claim, or ``""``.

    Refuses unless this host has the seam at all, and the core set ``request["peer"]``
    for a token scoped to this app. A body field, header or query parameter is never
    read here: on a gateway with no seam no request can pass, whoever sent it.
    """
    if seam(peers) is None:
        return ""
    try:
        claim = request.get("peer")
    except Exception:  # noqa: BLE001
        return ""
    if not isinstance(claim, Mapping) or claim.get("app") != APP_NAME:
        return ""
    gw = claim.get("gateway_id")
    return gw if isinstance(gw, str) and _ID_RE.match(gw) else ""


def hub_claims(params: Any) -> tuple[str, int]:
    """``(caller slug, hub turn cap)`` the hub states in the request metadata.

    The slug is a claim by the hub, trusted only because the hub's identity was verified
    and the owner listed ``<hub>/<slug>`` in ``allow_in``. A bad slug comes back ``""``
    (refused); a missing or bad cap comes back 0 (no extra cap from the hub).
    """
    meta = params.get("metadata") if isinstance(params, dict) else None
    block = meta.get(META_KEY) if isinstance(meta, dict) else None
    if not isinstance(block, dict):
        return "", 0
    slug = block.get("caller")
    cap = block.get("max_turns")
    cap = cap if isinstance(cap, int) and not isinstance(cap, bool) and cap >= 1 else 0
    return (slug if _slug(slug) else ""), cap


def effective_cap(local: int, fleet_cap: Optional[int], hub_cap: int) -> int:
    """The smaller of every cap that applies; never below 1."""
    caps = [local] + ([fleet_cap] if fleet_cap else []) + ([hub_cap] if hub_cap else [])
    return max(1, min(caps))
