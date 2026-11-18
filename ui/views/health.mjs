// Per-Bot health: is the a2a server mounted, does its command exist and survive upgrades,
// are its tools allowed. Repair re-applies the stable mount through the same reviewed path.

import { Button, Icon, Pill, h, plural } from '../lib/ui.mjs'
import { NoChat } from './setup.mjs'

function Check({ ok, label, detail }) {
  return h('li', { className: ok ? 'is-ok' : 'is-bad' },
    h(Icon, { name: ok ? 'Check' : 'X', size: 14 }),
    h('span', null, h('span', { className: 'a2a-sr' }, ok ? 'OK: ' : 'Problem: '), label),
    detail ? h('span', { className: 'a2a-faint a2a-mono a2a-wrap' }, detail) : null)
}

function BotHealth({ bot, onRepair, onOpenBot }) {
  const hl = bot.health
  if (!hl) {
    return h('li', { className: 'a2a-health-row' },
      h('div', { className: 'a2a-health-head' }, h('strong', null, bot.name), h(Pill, { tone: 'info' }, 'Set up by hand')),
      h('p', { className: 'a2a-faint' }, 'This Bot runs on a shared template, so a2a does not edit it for you. It can still be asked; to let it ask, add the a2a server in its Capabilities.'),
      h(Button, { kind: 'quiet', icon: 'ArrowRight', onClick: () => onOpenBot(bot) }, `Open ${bot.name}`))
  }
  return h('li', { className: `a2a-health-row ${hl.ok ? '' : 'is-bad'}` },
    h('div', { className: 'a2a-health-head' },
      h('strong', null, bot.name),
      h(Pill, { tone: hl.ok ? 'ok' : 'bad' }, hl.ok ? 'Healthy' : 'Needs repair'),
      !hl.ok && bot.ops.length ? h(Button, { kind: 'quiet', icon: 'Wrench', onClick: () => onRepair([bot.id]) }, 'Repair') : null),
    bot.chat === false ? h('p', { className: 'a2a-faint' }, `No chat yet: ${bot.name} can ask once its tools are mounted, but cannot be asked until you open its chat once.`) : null,
    h('ul', { className: 'a2a-health-checks' },
      h(Check, { ok: hl.mounted && !hl.disabled, label: 'Server mounted' }),
      h(Check, { ok: hl.command_exists && !hl.fragile, label: hl.fragile && hl.command_exists ? 'Command survives upgrades' : 'Command path exists', detail: hl.command || '' }),
      h(Check, { ok: hl.tools_enabled && !hl.tools_missing.length, label: 'Tools allowed',
        detail: hl.tools_missing.length ? `missing ${hl.tools_missing.join(', ')}` : '' })),
    !hl.ok ? h('p', { className: 'a2a-faint' }, hl.problems.join('. ') + '.') : null)
}

export default function Health({ setup, grants, onRepair, onOpenBot }) {
  const noChat = setup.no_chat || []
  const ids = setup.bots.map(b => b.id)
  const unticked = grants ? ids.filter(id => !grants.includes(id)) : []
  const stray = grants ? grants.filter(id => !ids.includes(id)) : []
  const owned = setup.bots.filter(b => b.health)
  const broken = setup.bots.filter(b => b.health && !b.health.ok && b.ops.length)
  return h('div', { className: 'a2a-health' },
    h('div', { className: 'a2a-access-bar' },
      h('p', null, broken.length
        ? `${plural(broken.length, 'Bot')} of ${setup.bots.length} need repair`
        : `${owned.length} of ${plural(setup.bots.length, 'Bot')} mounted and healthy${owned.length < setup.bots.length ? `; ${setup.bots.length - owned.length} set up by hand` : ''}`),
      broken.length > 1 ? h(Button, { icon: 'Wrench', onClick: () => onRepair(broken.map(b => b.id)) }, 'Repair all') : null),
    h('p', { className: 'a2a-faint' }, 'Setup and Repair mount every Bot with: ', h('span', { className: 'a2a-mono a2a-wrap' },
      [setup.transport.command || '(no system python3)', ...(setup.transport.args || [])].join(' '))),
    noChat.length ? h(NoChat, { bots: noChat, onOpenChat: onOpenBot }) : null,
    unticked.length ? h('p', { className: 'a2a-faint' }, `Not ticked under "Bots this app can reach" (a2a cannot wait for them when busy): ${unticked.map(id => (setup.bots.find(b => b.id === id) || {}).name || id).join(', ')}.`) : null,
    stray.length ? h('p', { className: 'a2a-faint' }, `Ticked but not a Bot a2a can ask: ${stray.join(', ')}.`) : null,
    h('ul', { className: 'a2a-health-list', 'aria-label': 'Each Bot' }, setup.bots.map(b => h(BotHealth, { key: b.id, bot: b, onRepair, onOpenBot }))))
}
