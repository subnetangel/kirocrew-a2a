// First-run panel, shown while setup is incomplete: three checks and one button.

import { Button, Icon, h, plural } from '../lib/ui.mjs'
export { setupState } from '../lib/setupState.mjs'

/** Bots with no chat thread yet: nothing can reach them until the owner opens their chat once. */
export function NoChat({ bots, onOpenChat }) {
  return h('div', { className: 'a2a-nochat' },
    h('p', null, h(Icon, { name: 'MessageSquare', size: 14 }),
      ` ${plural(bots.length, 'Bot')} ${bots.length === 1 ? 'has' : 'have'} no chat yet, so ${bots.length === 1 ? 'it' : 'they'} cannot be asked. Open ${bots.length === 1 ? 'its' : 'each'} chat once:`),
    h('div', { className: 'a2a-row-gap' }, bots.map(b =>
      h(Button, { key: b.id, kind: 'quiet', icon: 'ArrowRight', onClick: () => onOpenChat(b) }, `Open ${b.name}'s chat`))))
}

export default function Setup({ state, onStart, manual, noChat, onOpenChat, pythonOk, python, maxBots, orchAll, setOrchAll }) {
  const left = state.checks.filter(c => !c.done)
  return h('section', { className: 'a2a-banner', 'aria-labelledby': 'a2a-setup-h' },
    h('div', { className: 'a2a-banner-row' },
      h(Icon, { name: 'Power', size: 16 }),
      h('h2', { id: 'a2a-setup-h' }, `Setup: ${plural(left.length, 'step')} left`),
      h('span', { className: 'a2a-faint a2a-banner-what' }, left.map(c => c.title).join('; ')),
      h(Button, { kind: 'primary', icon: 'Power', onClick: onStart }, 'Finish setup')),
    h('details', { className: 'a2a-banner-more' },
      h('summary', null, 'What setup changes'),
      h('ul', { className: 'a2a-checks' }, state.checks.map(c => h('li', { key: c.key, className: c.done ? 'is-done' : '' },
        h(Icon, { name: c.done ? 'CircleCheck' : 'Circle', size: 16 }),
        h('span', null, h('span', { className: 'a2a-sr' }, c.done ? 'Done: ' : 'To do: '), c.title),
        h('span', { className: 'a2a-faint a2a-num' }, c.detail)))),
      state.allBots > maxBots ? h('label', { className: 'a2a-offer' },
        h('input', { type: 'checkbox', checked: orchAll, onChange: e => setOrchAll(e.target.checked) }),
        h('span', null, `Also let one question reach all your Bots at once (${state.allBots}; today the limit is ${maxBots})`)) : null,
      !pythonOk ? h('p', { className: 'a2a-warn-text' }, h(Icon, { name: 'TriangleAlert', size: 14 }),
        ` This computer has no system Python 3.9 or newer${python ? ` (${python} did not start)` : ''}, so a2a cannot mount its tools with a command that survives upgrades. The other steps still apply.`) : null,
      noChat.length ? h(NoChat, { bots: noChat, onOpenChat }) : null,
      manual.length ? h('p', { className: 'a2a-faint' }, `Set up by hand (their settings are a shared template): ${manual.map(b => b.name).join(', ')}. See Health.`) : null,
      h('p', { className: 'a2a-faint' }, 'Nothing changes until you confirm the list.')))
}
