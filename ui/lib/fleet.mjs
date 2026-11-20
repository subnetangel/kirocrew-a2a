// Fleet (0.7) page logic: the owner's edits to policy.fleet, kept pure so node can test it.
// The backend validates again (backend/peers.py clean_fleet); these checks only keep the
// form honest. Same patterns as the backend.

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const CREW = /^[a-z0-9][a-z0-9-]{0,31}$/
const ID = /^[A-Za-z0-9_.:-]{1,64}$/

export const EMPTY_FLEET = { crews: {}, allow_out: {}, allow_in: {}, max_turns: null }

/** The Kiro Crew feature request Fleet waits for. */
export const PEER_CALLS_ISSUE = 'https://github.com/kirodotdev/KiroCrew/issues/40040'

export const validCrew = s => CREW.test(String(s || ''))
export const validInstance = s => ID.test(String(s || ''))
export const validSlug = s => SLUG.test(String(s || ''))

/** "dev/alice": a Bot on another crew. */
export function validRemote(s) {
  const parts = String(s || '').split('/')
  return parts.length === 2 && CREW.test(parts[0]) && SLUG.test(parts[1])
}

/** "<hub gateway id>/<bot>": a Bot on another crew that may ask this one. */
export function validPeerKey(s) {
  const parts = String(s || '').split('/')
  return parts.length === 2 && ID.test(parts[0]) && SLUG.test(parts[1])
}

export const fleetOf = policy => ({ ...EMPTY_FLEET, ...((policy && policy.fleet) || {}) })

export function setCrew(fleet, alias, instance) {
  return { ...fleet, crews: { ...fleet.crews, [alias]: instance } }
}

/** Removing a crew also drops every outbound pair that names it. */
export function removeCrew(fleet, alias) {
  const crews = { ...fleet.crews }
  delete crews[alias]
  const allow_out = {}
  for (const [k, v] of Object.entries(fleet.allow_out || {})) {
    const left = v.filter(t => t.split('/')[0] !== alias)
    if (left.length) allow_out[k] = left
  }
  return { ...fleet, crews, allow_out }
}

/** Add *target* under *key* in one of the pair maps ('allow_out' or 'allow_in'). */
export function addPair(fleet, map, key, target) {
  const cur = (fleet[map] || {})[key] || []
  if (cur.includes(target)) return fleet
  return { ...fleet, [map]: { ...(fleet[map] || {}), [key]: [...cur, target].sort() } }
}

export function removePair(fleet, map, key, target) {
  const next = { ...(fleet[map] || {}) }
  const left = (next[key] || []).filter(t => t !== target)
  if (left.length) next[key] = left
  else delete next[key]
  return { ...fleet, [map]: next }
}

/** Flat rows for a pair map, for a table: [{ key, target }]. */
export function pairRows(map) {
  return Object.entries(map || {}).flatMap(([key, ts]) => ts.map(target => ({ key, target })))
    .sort((a, b) => (a.key + a.target).localeCompare(b.key + b.target))
}

/** Why an outbound pair cannot be added yet, or '' when it can. */
export function outPairProblem(fleet, bot, remote) {
  if (!validSlug(bot)) return 'Pick one of your Bots.'
  if (!validRemote(remote)) return 'Name the other Bot as <crew>/<bot>, for example dev/alice.'
  if (!(remote.split('/')[0] in (fleet.crews || {}))) return `Add the crew "${remote.split('/')[0]}" first.`
  return ''
}
