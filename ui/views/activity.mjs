// The live activity feed: every exchange, grouped by conversation and orchestration run.
// New items arrive at the top and keep their highlight until you have seen them, like a
// gate change on a departures board. Expanding an item loads the full question and answer.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { API } from '../lib/api.mjs'
import { OPS, OUTCOMES, SINCE, ago, clock, collapseRepeats, counts, filterItems, outcomeClass, reasonText } from '../lib/feed.mjs'
import { Button, Empty, ErrorBox, Icon, Pill, Skeleton, h, plural } from '../lib/ui.mjs'

function Who({ item, name }) {
  if (item.kind === 'event') return h('span', null, eventText(item.final))
  const caller = name(item.caller) || 'Unknown caller'
  if (item.kind === 'run' || item.targets.length > 1) {
    return h('span', null, h('strong', null, caller), ' asked ', h('strong', null, plural(item.targets.length, 'Bot')),
      h('span', { className: 'a2a-faint' }, ` ${item.targets.map(name).join(', ')}`))
  }
  return h('span', null, h('strong', null, caller), h(Icon, { name: 'ArrowRight', size: 13, className: 'a2a-arrow' }),
    h('strong', null, name(item.targets[0]) || 'unknown Bot'))
}

function eventText(row) {
  if (row.op === 'policy' && row.outcome === 'seeded') return 'Policy seeded from the installed copy'
  if (row.op === 'policy') return `Policy updated by ${row.by === 'owner' ? 'you' : row.by || 'the owner'}`
  if (row.op === 'migrate') return 'Policy and history moved to gateway-only storage. Review who may ask whom once.'
  return `${row.op} ${row.outcome}`
}

function Message({ m, name, role }) {
  return h('div', { className: `a2a-msg a2a-msg-${role}` },
    h('div', { className: 'a2a-msg-head' },
      h('strong', null, name(m.from)), h('span', { className: 'a2a-faint' }, role === 'q' ? 'asked' : 'answered'),
      h('time', { className: 'a2a-faint a2a-num', dateTime: m.ts }, clock(m.ts))),
    h('div', { className: 'a2a-msg-text' }, m.text))
}

// One Bot's line in an orchestration card: who answered, and how its part ended. A Bot
// that timed out or was busy is marked on its own line; the rest of the run stands.
function RunHead({ item, convo, name }) {
  const rows = item.rows.filter(r => r.context === convo.context)
  const end = [...rows].reverse().find(r => r.outcome !== 'delivering')
  const runDone = item.rows.some(r => r.op === 'orchestrate' && r.outcome === 'completed')
  const target = (rows[0] && rows[0].target) || (convo.pair || []).find(p => p !== item.caller) || ''
  const tone = end ? outcomeClass(end.outcome) : runDone ? 'failed' : 'working'
  const why = end ? (tone === 'answered' ? '' : reasonText(end)) : runDone ? 'No answer inside the run\'s time budget' : ''
  return h('div', { className: 'a2a-run-head' }, h('h3', null, name(target)), h(Pill, { tone }),
    why ? h('span', { className: `a2a-item-reason is-${tone}` }, why) : null)
}

// A folded run of identical failures: one line per attempt, newest first.
function Repeats({ item, name }) {
  return h('div', { className: 'a2a-detail' },
    h('p', { className: 'a2a-faint' }, `${item.repeats.length} attempts failed the same way: ${item.reason || 'no reason recorded'}.`),
    h('ul', { className: 'a2a-refusals' }, item.repeats.map(r => h('li', { key: r.key },
      h(Pill, { tone: r.cls }), h('span', null, `${name(r.caller)} to ${r.targets.map(name).join(', ')}`),
      h('time', { className: 'a2a-faint a2a-num', dateTime: r.last }, clock(r.last))))))
}

function Detail({ item, client, name }) {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let live = true
    if (!item.contexts.length) { setState({ convos: [] }); return }
    Promise.all(item.contexts.map(c => client.get(`${API}/conversations/${encodeURIComponent(c)}`)))
      .then(convos => live && setState({ convos }), error => live && setState({ error }))
    return () => { live = false }
  }, [item.key, item.contexts.length])
  if (state.loading) return h(Skeleton, { rows: 3, label: 'Loading the conversation' })
  if (state.error) return h(ErrorBox, { title: 'Could not load the conversation', error: state.error })
  const convos = state.convos || []
  const refusals = item.rows.filter(r => ['denied', 'rejected', 'busy', 'timeout', 'error', 'duplicate', 'queued'].includes(r.outcome))
  const question = item.kind === 'run' && convos[0] ? (convos[0].messages || []).find(m => m.role === 'user') : null
  return h('div', { className: 'a2a-detail' },
    refusals.length ? h('ul', { className: 'a2a-refusals' }, refusals.map((r, i) =>
      h('li', { key: i }, h(Pill, { tone: ['timeout', 'error'].includes(r.outcome) ? 'failed' : r.outcome === 'queued' ? 'working' : 'refused' }),
        h('span', null, name(r.target) ? `${name(r.target)}: ` : '', item.reasonFor(r)),
        h('time', { className: 'a2a-faint a2a-num', dateTime: r.ts }, clock(r.ts))))) : null,
    question ? h(Message, { m: question, name, role: 'q' }) : null,
    convos.map(c => h('div', { key: c.context, className: 'a2a-convo' },
      item.kind === 'run' ? h(RunHead, { item, convo: c, name }) : null,
      (c.messages || []).filter((m, i, arr) => !(question && m === arr.find(x => x.role === 'user')))
        .map((m, i) => h(Message, { key: i, m, name, role: m.role === 'user' ? 'q' : 'a' })),
      !(c.messages || []).length ? h('p', { className: 'a2a-faint' }, 'No messages were recorded on this conversation.') : null,
      h('p', { className: 'a2a-faint a2a-mono' }, `context ${c.context}`))),
    !convos.length && !refusals.length ? h('p', { className: 'a2a-faint' }, 'Nothing more was recorded for this event.') : null)
}

function Item({ item, open, onToggle, isNew, arrived, client, name }) {
  const id = `a2a-item-${item.key.replace(/[^a-z0-9]/gi, '')}`
  const label = item.kind === 'run' ? `Orchestration, ${plural(item.targets.length, 'Bot')}` : item.kind === 'conversation' ? `${item.turns || 1} of ${item.maxTurns} turns` : ''
  return h('li', { className: `a2a-item is-${item.cls} ${isNew ? 'is-new' : ''} ${arrived ? 'is-arrived' : ''}` },
    h('button', { type: 'button', className: 'a2a-item-row', 'aria-expanded': open, 'aria-controls': `${id}-d`, onClick: onToggle },
      h('time', { className: 'a2a-num a2a-faint', dateTime: item.last, title: item.last }, clock(item.last)),
      h('span', { className: 'a2a-item-who' }, h(Who, { item, name }),
        item.reason && item.cls !== 'answered' ? h('span', { className: `a2a-item-reason is-${item.cls}` }, item.reason) : null),
      h('span', { className: 'a2a-item-meta a2a-faint' }, label),
      h('span', { className: 'a2a-item-state' },
        isNew ? h('span', { className: 'a2a-new-tag' }, 'New') : null,
        item.repeats ? h('span', { className: 'a2a-repeat a2a-num', 'aria-label': `${item.repeats.length} times` }, `\u00d7${item.repeats.length}`) : null,
        item.kind === 'event' ? null : h(Pill, { tone: item.cls })),
      h(Icon, { name: open ? 'ChevronDown' : 'ChevronRight', size: 16, className: 'a2a-chev' })),
    open ? h('div', { id: `${id}-d`, className: 'a2a-item-detail' },
      item.repeats ? h(Repeats, { item, name }) : h(Detail, { item, client, name })) : null)
}

function Filters({ bots, filter, setFilter, tally }) {
  const set = (k, v) => setFilter({ ...filter, [k]: v })
  return h('div', { className: 'a2a-filters', role: 'group', 'aria-label': 'Filter activity' },
    h('label', null, h('span', { className: 'a2a-sr' }, 'Bot'),
      h('select', { value: filter.bot, onChange: e => set('bot', e.target.value) },
        h('option', { value: '' }, 'All Bots'), bots.map(b => h('option', { key: b.id, value: b.id }, b.name)))),
    h('div', { className: 'a2a-seg', role: 'radiogroup', 'aria-label': 'Outcome' },
      [['', 'All'], ...OUTCOMES].map(([v, l]) => h('button', {
        key: v || 'all', type: 'button', role: 'radio', 'aria-checked': filter.outcome === v,
        className: `a2a-seg-btn ${filter.outcome === v ? 'is-on' : ''} ${v ? `is-${v}` : ''}`, onClick: () => set('outcome', v),
      }, l, v && tally[v] ? h('span', { className: 'a2a-num' }, tally[v]) : null))),
    h('label', null, h('span', { className: 'a2a-sr' }, 'Time'),
      h('select', { value: filter.since || '24h', onChange: e => set('since', e.target.value) },
        SINCE.map(([v, l]) => h('option', { key: v, value: v }, l)))),
    h('label', null, h('span', { className: 'a2a-sr' }, 'Kind'),
      h('select', { value: filter.op, onChange: e => set('op', e.target.value) },
        h('option', { value: '' }, 'Everything'), OPS.map(([v, l]) => h('option', { key: v, value: v }, l)))))
}

export default function Activity({ items, loading, error, onRetry, bots, client, name, filter, setFilter, seen, markSeen, arrived, maxTurns, reasonFor, now }) {
  const [open, setOpen] = useState(() => new Set())
  const shown = useMemo(() => collapseRepeats(filterItems(items, filter, now)), [items, filter, now])
  const tally = useMemo(() => counts(filterItems(items, { ...filter, outcome: '' }, now)), [items, filter, now])
  const fresh = items.filter(it => it.last > seen.at && !seen.keys.includes(it.key))
  const toggle = it => {
    setOpen(s => { const n = new Set(s); n.has(it.key) ? n.delete(it.key) : n.add(it.key); return n })
    markSeen([it.key])
  }
  const last = items[0]
  return h(Fragment, null,
    h('div', { className: 'a2a-feed-bar' },
      h(Filters, { bots, filter, setFilter, tally }),
      fresh.length ? h(Button, { kind: 'quiet', icon: 'Eye', onClick: () => markSeen(null) }, `Mark ${fresh.length} seen`) : null),
    h('p', { className: 'a2a-sr', 'aria-live': 'polite' }, fresh.length ? `${plural(fresh.length, 'new exchange')}` : ''),
    error ? h(ErrorBox, { title: 'Could not load activity', error, onRetry }) : null,
    loading && !items.length ? h(Skeleton, { rows: 5, label: 'Loading activity' }) : null,
    !loading && !error && !items.length ? h(Empty, { icon: 'MessagesSquare', title: 'No exchanges yet' },
      'When one Bot asks another, the question, the answer and any refusal show up here within seconds.') : null,
    items.length && !shown.length ? h(Empty, { icon: 'Filter', title: 'Nothing matches these filters' },
      h(Button, { kind: 'quiet', onClick: () => setFilter({ bot: '', outcome: '', op: '', since: 'all' }) }, 'Show everything')) : null,
    shown.length ? h('ul', { className: 'a2a-feed', 'aria-label': 'Exchanges, newest first' }, shown.map(it => h(Item, {
      key: it.key, item: { ...it, maxTurns, reasonFor }, open: open.has(it.key), onToggle: () => toggle(it),
      isNew: it.last > seen.at && !seen.keys.includes(it.key), arrived: arrived.has(it.key), client, name,
    }))) : null,
    last ? h('p', { className: 'a2a-faint a2a-feed-foot' }, `Updated every 10 seconds. Newest ${ago(last.last, now)}.`) : null)
}
