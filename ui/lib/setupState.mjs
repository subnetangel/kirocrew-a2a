// What the setup banner counts, from GET /setup. Pure, so node can test it.
// Every count is over the owner's roster Bots (setup.bots), the same list Health,
// the grid and 'All my Bots' read.

export function setupState(setup, grants, maxBots = 0) {
  const bots = setup.bots
  const ids = bots.map(b => b.id)
  const owned = bots.filter(b => b.owned)
  const unreadable = bots.filter(b => b.unreadable)
  const ready = owned.filter(b => b.health && b.health.ok)
  const ticked = ids.filter(id => (grants || []).includes(id))
  // Ticks under "Bots this app can reach" that name no Bot a2a can reach (a default
  // agent, a worker template): harmless, but they make the two lists disagree.
  const strayTicks = (grants || []).filter(id => !ids.includes(id))
  const unticked = ids.filter(id => !(grants || []).includes(id))
  const pairs = ids.length * Math.max(0, ids.length - 1)
  const missing = setup.policy.missing_pairs.length
  const checks = [
    { key: 'policy', done: setup.policy.complete, title: 'Every Bot may ask every other Bot',
      detail: `${pairs - missing} of ${pairs} pairs allowed` },
    { key: 'mounts', done: setup.mounts_complete, title: 'a2a tools on each Bot, with a command that survives upgrades',
      detail: `${ready.length} of ${owned.length} Bots ready${unreadable.length ? `; could not read ${unreadable.map(b => b.name).join(', ')}` : ''}` },
    { key: 'grants', done: grants !== null && ticked.length === ids.length, title: 'Every Bot ticked under "Bots this app can reach"',
      detail: grants === null ? 'could not read' : `${ticked.length} of ${ids.length} ticked` },
  ]
  // The fan-out offer: one question to every other Bot, inside the hard cap of 16. It counts
  // Bots with no chat yet too, because a2a_orchestrate(["all"]) asks them (each gets its own line).
  const allBots = Math.min(16, Math.max(0, ids.length - 1))
  checks.push({ key: 'orch', done: maxBots >= allBots, title: 'One question can reach all your Bots',
    detail: `Bots per orchestration: ${maxBots} of ${allBots}` })
  return { checks, complete: checks.every(c => c.done) && ids.length > 1, ids, allBots, strayTicks, unticked,
    owned: owned.length, ready: ready.length }
}

