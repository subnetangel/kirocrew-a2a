# Security

Please report security problems privately, through GitHub's private
vulnerability reporting:
[Report a vulnerability](https://github.com/subnetangel/kirocrew-a2a/security/advisories/new).

Do not open a public issue for a security problem.

Useful details: the app version (`app.json`), the Kiro Crew version, what you did,
what you expected, and what happened. A report is acknowledged as soon as it is
read; a fix ships as a new app version.

## Scope

In scope: this app's code (backend hooks and routes, the stdio MCP server, the
page) and its policy enforcement: who may ask whom, answer-only framing, turn
limits, redaction, and the outbox writer check.

Out of scope: Kiro Crew itself. Report those to
[kirodotdev/KiroCrew](https://github.com/kirodotdev/KiroCrew/blob/main/SECURITY.md).
