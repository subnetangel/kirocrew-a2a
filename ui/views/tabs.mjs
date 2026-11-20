// A WAI-ARIA tablist: one tab stop (roving tabindex), Left/Right/Home/End move and
// select, aria-selected and aria-controls link each tab to its panel.

import { useRef } from 'react'
import { Icon, h } from '../lib/ui.mjs'

export const TABS = [
  ['activity', 'Activity', 'Activity'],
  ['access', 'Who may ask whom', 'Network'],
  ['limits', 'Limits', 'Gauge'],
  ['health', 'Health', 'HeartPulse'],
  ['cos', 'Chief of Staff', 'Crown'],
  ['fleet', 'Fleet', 'Server'],
]

export function tabFromUrl(fallback) {
  try {
    const t = new URLSearchParams(window.location.search).get('tab')
    return TABS.some(([id]) => id === t) ? t : fallback
  } catch { return fallback }
}

export function writeTab(tab) {
  try {
    const q = new URLSearchParams(window.location.search)
    q.set('tab', tab)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${q}${window.location.hash}`)
  } catch { /* not a browser */ }
}

export function TabList({ tab, onSelect, badges = {} }) {
  const refs = useRef({})
  const go = i => {
    const [id] = TABS[(i + TABS.length) % TABS.length]
    onSelect(id)
    const el = refs.current[id]
    if (el) el.focus()
  }
  const onKey = (e, i) => {
    const keys = { ArrowRight: () => go(i + 1), ArrowLeft: () => go(i - 1), Home: () => go(0), End: () => go(TABS.length - 1) }
    if (keys[e.key]) { e.preventDefault(); keys[e.key]() }
  }
  return h('div', { className: 'a2a-tabs', role: 'tablist', 'aria-label': 'A2A sections' },
    TABS.map(([id, label, icon], i) => h('button', {
      key: id, id: `a2a-tab-${id}`, type: 'button', role: 'tab', ref: el => { refs.current[id] = el },
      className: `a2a-tab ${tab === id ? 'is-on' : ''}`, 'aria-selected': tab === id, 'aria-controls': `a2a-panel-${id}`,
      tabIndex: tab === id ? 0 : -1, onClick: () => onSelect(id), onKeyDown: e => onKey(e, i),
    }, h(Icon, { name: icon, size: 15 }), h('span', null, label),
    badges[id] ? h('span', { className: `a2a-tab-badge is-${badges[id].tone || 'info'}` }, badges[id].text) : null)))
}

export function TabPanel({ id, tab, children }) {
  return h('div', { id: `a2a-panel-${id}`, role: 'tabpanel', 'aria-labelledby': `a2a-tab-${id}`, hidden: tab !== id,
    className: 'a2a-panel', tabIndex: 0 }, tab === id ? children : null)
}
