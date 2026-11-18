// Auto-heal: when the owner opens the A2A page or a panel tab, a Bot that already mounts
// a2a correctly but lacks tools a newer a2a added gets them, through the same owner
// preview -> PUT path as Repair, with no button press. Only the backend's ``heal`` ops are
// used: allowedTools a2a entries, never a mount and never anything else. Every change is
// recorded so Undo removes exactly what was added. A failed Bot stays amber and is
// tried again on the next page load.

import { RETRY_DELAY_MS, with503Retry } from './apply.mjs'

async function applyOps(client, agent, operations, retryDelayMs) {
  const retry = { delayMs: retryDelayMs }
  const view = await with503Retry(() => client.capabilities(agent), retry)
  const body = { revision: view.revision, operations }
  const preview = await with503Retry(() => client.previewCapabilities(agent, body), retry)
  await client.commitCapabilities(agent, { ...body, preview_token: preview.preview_token })
}

/** Heal every Bot with heal ops, one at a time. Resolves to { healed: [{id, agent, ids}], failed: [id] }. */
export async function autoHeal(client, setup, policy, { retryDelayMs = RETRY_DELAY_MS } = {}) {
  const out = { healed: [], failed: [] }
  if (!setup || !policy || policy.auto_update_tools === false) return out
  for (const bot of setup.bots || []) {
    const ops = (bot.heal || []).filter(o => o.section === 'allowedTools' && o.action === 'set' && String(o.id).startsWith('@a2a:a2a'))
    if (!ops.length || !bot.health || !bot.health.ok) continue
    try {
      await applyOps(client, bot.agent, ops, retryDelayMs)
      out.healed.push({ id: bot.id, agent: bot.agent, ids: ops.map(o => o.id) })
    } catch {
      out.failed.push(bot.id)
    }
  }
  return out
}

/** Remove exactly the entries autoHeal added. Resolves to the ids of Bots it could not undo. */
export async function undoHeal(client, healed, { retryDelayMs = RETRY_DELAY_MS } = {}) {
  const failed = []
  for (const h of healed) {
    try {
      await applyOps(client, h.agent, h.ids.map(id => ({ section: 'allowedTools', id, action: 'remove' })), retryDelayMs)
    } catch { failed.push(h.id) }
  }
  return failed
}
