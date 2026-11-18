// Pure edits of the policy's allow map for the who-may-ask-whom grid. Every edit touches
// only the pairs among the Bots the grid shows (*ids*); every other caller, target and
// pair in *allow* is carried through unchanged, so a save never drops a Bot that is
// not on screen.

export function setPair(allow, from, to, on) {
  const set = new Set(allow[from] || [])
  on ? set.add(to) : set.delete(to)
  return { ...allow, [from]: [...set].sort() }
}

export function setRow(allow, ids, a, on) {
  let next = allow
  for (const b of ids) if (b !== a) next = setPair(next, a, b, on)
  return next
}

export function setCol(allow, ids, b, on) {
  let next = allow
  for (const a of ids) if (a !== b) next = setPair(next, a, b, on)
  return next
}

export function setAll(allow, ids, on) {
  let next = allow
  for (const a of ids) next = setRow(next, ids, a, on)
  return next
}

/** *allow* without agent *id*: its own row, and every pair that names it. */
export function removeAgent(allow, id) {
  const out = {}
  for (const [caller, targets] of Object.entries(allow || {})) {
    if (caller === id) continue
    out[caller] = (targets || []).filter(t => t !== id)
  }
  return out
}
