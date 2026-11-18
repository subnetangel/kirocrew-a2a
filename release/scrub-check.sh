#!/usr/bin/env bash
# Pre-publish scrub for kirocrew-a2a. Checks the files git would publish
# (git ls-files) and exits non-zero on any hit. Repeatable: run it from the
# repo root before every push.
#
# Secret scanning: uses gitleaks or trufflehog when one is on PATH, else the
# pattern grep below (it says which it used).
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

SELF="release/scrub-check.sh"
PAT_REL="${SCRUB_PATTERNS_FILE:-release/scrub-patterns.local}"
mapfile -t FILES < <(git ls-files --cached --others --exclude-standard | grep -vxF -e "$SELF" -e "$PAT_REL")
TEXT=()
for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  if grep -Iq . "$f" 2>/dev/null || [ ! -s "$f" ]; then TEXT+=("$f"); fi
done

hits=0
check() {  # check <label> <extended-regex> [grep flags]
  local label="$1" re="$2" flags="${3:--niE}" out
  out=$(grep $flags -e "$re" -- "${TEXT[@]}" 2>/dev/null || true)
  if [ -n "$out" ]; then
    local n; n=$(printf '%s\n' "$out" | wc -l)
    hits=$((hits + n))
    printf 'FAIL %-26s %3d hit(s)\n' "$label" "$n"
    printf '%s\n' "$out" | cut -c1-200 | sed 's/^/     /'
  else
    printf 'ok   %s\n' "$label"
  fi
}

echo "== kirocrew-a2a scrub, $(git rev-parse --short HEAD 2>/dev/null || echo no-commit), ${#TEXT[@]} text files of ${#FILES[@]}"

# 1. Paths that must not ship at all.
bad_paths=$(printf '%s\n' "${FILES[@]}" | grep -E '(^|/)(evidence|transcripts?|patches|deliverables|audit|private|results|outbox|claimed|contexts|conversations)(/|$)|(^|/)policy\.json$|\.jsonl$|\.patch$|\.bak' || true)
if [ -n "$bad_paths" ]; then
  n=$(printf '%s\n' "$bad_paths" | wc -l); hits=$((hits + n))
  printf 'FAIL %-26s %3d hit(s)\n' "forbidden files" "$n"; printf '%s\n' "$bad_paths" | sed 's/^/     /'
else
  printf 'ok   %s\n' "forbidden files"
fi

# 2. Local name checks. The names to look for (home paths, hosts, people, internal
# systems, private agent and customer names) are not in this repo. They come from a
# local, untracked file: release/scrub-patterns.local (git-ignored), or the path in
# $SCRUB_PATTERNS_FILE. One check per line: label<TAB>grep flags<TAB>regex; lines
# starting with # are comments. With no file, or one with no checks, the scrub
# refuses to run: it must never report clean by default.
PATTERNS="${SCRUB_PATTERNS_FILE:-release/scrub-patterns.local}"
n_patterns=0
if [ -f "$PATTERNS" ]; then
  while IFS=$'\t' read -r label flags re || [ -n "$label" ]; do
    case "$label" in ''|'#'*) continue ;; esac
    if [ -z "${re:-}" ]; then
      echo "malformed line in patterns file (want label<TAB>flags<TAB>regex): $label" >&2; exit 2
    fi
    check "$label" "$re" "$flags"
    n_patterns=$((n_patterns + 1))
  done < "$PATTERNS"
fi
if [ "$n_patterns" -eq 0 ]; then
  echo "no patterns file; refusing to report clean (looked for ${PATTERNS})" >&2
  exit 2
fi

# 3. Emails other than the publishing noreply address.
emails=$(grep -noE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- "${TEXT[@]}" 2>/dev/null \
  | grep -vE ':[0-9]+:5580684\+subnetangel@users\.noreply\.github\.com$' \
  | grep -vE '@(example\.(com|org)|kirocrew\.dev)$' || true)
if [ -n "$emails" ]; then
  n=$(printf '%s\n' "$emails" | wc -l); hits=$((hits + n))
  printf 'FAIL %-26s %3d hit(s)\n' "emails" "$n"; printf '%s\n' "$emails" | sed 's/^/     /'
else
  printf 'ok   %s\n' "emails"
fi

# 4. Secrets.
if command -v gitleaks >/dev/null 2>&1; then
  echo "     (secrets: gitleaks)"
  gitleaks detect --no-git --source . --redact -q || { hits=$((hits + 1)); echo "FAIL secrets (gitleaks)"; }
elif command -v trufflehog >/dev/null 2>&1; then
  echo "     (secrets: trufflehog)"
  trufflehog filesystem . --fail --no-update -j >/dev/null || { hits=$((hits + 1)); echo "FAIL secrets (trufflehog)"; }
else
  echo "     (secrets: pattern grep; gitleaks and trufflehog are not installed)"
  # The test fixtures use the literal placeholder ghp_SECRETSECRET to prove redaction;
  # real GitHub tokens are 36+ chars after the prefix, so the length bound skips it.
  check "secrets"        'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|aws_secret_access_key|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[abpors]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.' -nE
fi

# 5. Listeners. The app opens no socket; mcp_server.py speaks stdio only.
check "listeners"        '0\.0\.0\.0|\[::\]|\.listen\(|--host|TCPSite|UnixSite|run_app\(|create_server|socket\.socket|HTTPServer|serve_forever' -nE
if grep -nE '^\s*(import|from)\s+(socket|http\.server|socketserver|aiohttp)' backend/mcp_server.py >/dev/null; then
  hits=$((hits + 1)); echo "FAIL mcp_server.py imports a network module"
else
  printf 'ok   %s\n' "mcp_server.py stdio only (reads sys.stdin, writes sys.stdout)"
fi

# 6. Shipped seed must be deny-all.
if python3 - <<'EOF'
import json, sys
d = json.load(open("policy.seed.example.json"))
sys.exit(0 if not any(d.get("allow", {}).values()) else 1)
EOF
then printf 'ok   %s\n' "policy.seed.example.json is deny-all"
else hits=$((hits + 1)); echo "FAIL policy.seed.example.json allows someone"; fi
for f in policy.seed.json; do
  if [ -e "$f" ]; then hits=$((hits + 1)); echo "FAIL $f must not ship"; fi
done

# 7. Docs match code: the turn default the README states is the one core.py ships.
code_turns=$(grep -oP '^DEFAULT_MAX_TURNS = \K[0-9]+' backend/core.py)
seed_turns=$(python3 -c 'import json;print(json.load(open("policy.seed.example.json"))["max_turns_per_context"])')
if grep -q "allows ${code_turns} turns by default" README.md && [ "$seed_turns" = "$code_turns" ]; then
  printf 'ok   %s\n' "turn default ${code_turns} matches README and seed"
else
  hits=$((hits + 1)); echo "FAIL turn default: core.py=${code_turns}, seed=${seed_turns}, README does not say 'allows ${code_turns} turns by default'"
fi

echo "== total hits: $hits"
[ "$hits" -eq 0 ]
