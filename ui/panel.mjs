// The A2A tab in a chat's side panel: THIS Bot's A2A view. Mounted by the host from
// contributes.panelTabs (no props). The host binds the panel to its chat session
// (useAppInfo().session.sessionKey); the backend maps that key to a Bot only through
// the gateway's own records. A chat that is not a Bot's, or a host without the field,
// gets a Bot picker that remembers the last choice. Every write is the owner's own
// session: PUT /policy for who-may-ask-whom, the reviewed Repair, and task Cancel.

import { useCallback, useEffect, useState } from 'react'
import { API, SDK, useClient, useNav } from './lib/api.mjs'
import { collapseRepeats, groupRows, reasonText } from './lib/feed.mjs'
import { setPair } from './lib/matrix.mjs'
import { Button, Empty, ErrorBox, Icon, Pill, Skeleton, h, plural, usePersisted, useStyles } from './lib/ui.mjs'
import Activity from './views/activity.mjs'
import Confirm from './views/confirm.mjs'
import { autoHeal, undoHeal } from './lib/heal.mjs'
import { STATUS_TONE, STATUS_WORD, ageText } from './lib/cos.mjs'

const POLL_MS = 15000
const useAppInfo = typeof SDK.useAppInfo === 'function' ? SDK.useAppInfo : () => ({ active: true })

function useInfo() {
  try { return useAppInfo() || {} } catch { return {} }
}

function Pairs({ title, bot, others, has, onToggle, busy }) {
  return h('fieldset', { className: 'a2a-side-pairs' },
    h('legend', null, title),
    others.length ? others.map(o => h('label', { key: o.id, className: 'a2a-side-pair' },
      h('input', { type: 'checkbox', checked: has(o.id), disabled: busy, onChange: () => onToggle(o.id) }),
      h('span', null, o.name), o.chat === false ? h('span', { className: 'a2a-nochat-tag' }, 'no chat') : null))
      : h('p', { className: 'a2a-faint' }, `No other Bots to pair ${bot.name} with yet.`))
}

function Tasks({ tasks, onCancel, name }) {
  const open = tasks.filter(t => (t.status || {}).state === 'TASK_STATE_WORKING')
  if (!open.length) return h('p', { className: 'a2a-faint' }, 'No open tasks.')
  return h('ul', { className: 'a2a-refusals' }, open.map(t => h('li', { key: t.id },
    h(Pill, { tone: 'working' }),
    h('span', null, `${name(t.caller)} to ${name(t.target)}`),
    h(Button, { kind: 'quiet', className: 'a2a-btn-sm', icon: 'X', onClick: () => onCancel(t) }, 'Cancel'))))
}

export default function A2APanel() {
  const client = useClient()
  const navigate = useNav()
  const info = useInfo()
  const active = info.active !== false
  const sessionKey = (info.session && info.session.sessionKey) || ''
  const [picked, setPicked] = usePersisted('panelBot', '')
  const [fromChat, setFromChat] = useState(null)  // null = still asking the gateway
  const [roster, setRoster] = useState([])
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState(null)
  const [filter, setFilter] = useState({ bot: '', outcome: '', op: '', since: '7d' })
  const [cancelNote, setCancelNote] = useState('')
  const [healed, setHealed] = useState(null)
  const [triedHeal, setTriedHeal] = useState('')
  useStyles(view && view.version)

  useEffect(() => {
    let live = true
    const ask = sessionKey ? client.get(`${API}/session-bot?key=${encodeURIComponent(sessionKey)}`) : Promise.resolve({ bot: '' })
    ask.then(r => live && setFromChat(r.bot || ''), () => live && setFromChat(''))
    client.get(`${API}/setup`).then(s => live && setRoster((s.bots || []).map(b => ({ id: b.id, name: b.name }))), () => {})
    return () => { live = false }
  }, [sessionKey])

  const slug = fromChat || picked
  const load = useCallback(async () => {
    if (!slug) return
    try { setView(await client.get(`${API}/bot/${encodeURIComponent(slug)}`)); setError(null) } catch (e) { setError(e) }
  }, [slug])
  useEffect(() => { setView(null); load() }, [load])
  useEffect(() => {
    if (!active || !slug) return undefined
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [active, load, slug])

  useEffect(() => {
    if (!view || triedHeal === slug || !(view.bot.heal || []).length) return
    setTriedHeal(slug)
    client.get(`${API}/policy`).then(p => autoHeal(client, { bots: [view.bot] }, p))
      .then(r => { if (r.healed.length) { setHealed(r); load() } }, () => {})
  }, [view, slug])
  const name = id => id === 'owner' ? 'You' : ((view && view.bots.find(b => b.id === id)) || {}).name || id
  const toggle = async (from, to) => {
    setBusy(true)
    try {
      const p = await client.get(`${API}/policy`)
      const on = !((p.allow || {})[from] || []).includes(to)
      await client.put(`${API}/policy`, { ...p, allow: setPair(p.allow || {}, from, to, on) })
      await load()
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const cancel = async t => {
    try {
      await client.post(`${API}/tasks/${encodeURIComponent(t.id)}/cancel`, {})
      setCancelNote(`Canceled. a2a stopped waiting; ${name(t.target)} may still finish its reply in its own chat.`)
      await load()
    } catch (e) { setError(e) }
  }
  const repair = () => {
    const bot = view.bot
    setDialog({ runId: `panel-${bot.id}-${Date.now().toString(36)}`, plan: {
      setup: { bots: [bot], policy: { complete: true, missing_pairs: [], proposed_allow: {} } },
      policy: {}, grants: null, want: { policy: false, grants: false, bots: [bot.id] } } })
  }

  if (fromChat === null) return h('div', { className: 'a2a a2a-side' }, h(Skeleton, { rows: 3, label: 'Finding this chat\'s Bot' }))

  const picker = !fromChat ? h('label', { className: 'a2a-side-picker' },
    h('span', null, sessionKey ? 'This chat is not a Bot\'s chat. Show:' : 'Show A2A for:'),
    h('select', { value: picked, onChange: e => setPicked(e.target.value) },
      h('option', { value: '' }, 'Choose a Bot'), roster.map(b => h('option', { key: b.id, value: b.id }, b.name)))) : null

  if (!slug) return h('div', { className: 'a2a a2a-side' }, picker,
    h(Empty, { icon: 'Network', title: 'Pick a Bot' }, 'Its A2A health, who it may ask, and its conversations show here.'))

  const bot = view && view.bot
  const hl = bot && bot.health
  const others = view ? view.bots.filter(b => b.id !== slug) : []
  const items = view ? collapseRepeats(groupRows(view.rows)) : []

  return h('div', { className: 'a2a a2a-side' },
    picker,
    error ? h(ErrorBox, { title: 'A2A did not answer', error, onRetry: load }) : null,
    !view && !error ? h(Skeleton, { rows: 4, label: 'Loading this Bot\'s A2A view' }) : null,
    view ? h('header', { className: 'a2a-side-head' },
      h('h2', null, `A2A for ${bot.name}`),
      h(Button, { kind: 'quiet', icon: 'ArrowRight', onClick: () => navigate && navigate(`/apps/a2a?bot=${encodeURIComponent(slug)}`) }, 'Open in A2A')) : null,
    healed ? h('p', { className: 'a2a-healed', role: 'status' }, `Updated ${bot ? bot.name : 'this Bot'} to the ${view ? view.version : '0.5'} tool list.`,
      h(Button, { kind: 'quiet', className: 'a2a-btn-sm', onClick: async () => { await undoHeal(client, healed.healed); setHealed(null); load() } }, 'Undo')) : null,
    view ? h('section', { className: 'a2a-side-card', 'aria-label': 'Health' },
      h('div', { className: 'a2a-health-head' },
        h('strong', null, 'Health'),
        hl ? h(Pill, { tone: !hl.ok ? 'bad' : hl.update_available ? 'update' : 'ok' }, !hl.ok ? 'Needs repair' : hl.update_available ? 'Update available' : 'Healthy') : h(Pill, { tone: 'info' }, 'Set up by hand'),
        hl && !hl.ok && bot.ops.length ? h(Button, { kind: 'quiet', icon: 'Wrench', onClick: repair }, 'Repair') : null),
      h('ul', { className: 'a2a-health-checks' },
        hl ? h('li', { className: hl.mounted && !hl.disabled ? 'is-ok' : 'is-bad' }, h(Icon, { name: hl.mounted ? 'Check' : 'X', size: 14 }), h('span', null, 'Server mounted')) : null,
        hl ? h('li', { className: hl.command_exists && !hl.fragile ? 'is-ok' : 'is-bad' }, h(Icon, { name: hl.command_exists && !hl.fragile ? 'Check' : 'X', size: 14 }), h('span', null, 'Command survives upgrades')) : null,
        hl ? h('li', { className: !hl.tools_missing.length && hl.tools_enabled ? 'is-ok' : 'is-bad' }, h(Icon, { name: hl.tools_missing.length ? 'X' : 'Check', size: 14 }),
          h('span', null, hl.tools_missing.length ? `Not allowed: ${hl.tools_missing.join(', ')}` : 'Tools allowed')) : null,
        h('li', { className: bot.chat !== false ? 'is-ok' : 'is-bad' }, h(Icon, { name: bot.chat !== false ? 'Check' : 'X', size: 14 }),
          h('span', null, bot.chat !== false ? 'Chat open, so it can be asked' : 'No chat yet: open it once so it can be asked')))) : null,
    view ? h('section', { className: 'a2a-side-card', 'aria-label': 'Who may ask whom' },
      h(Pairs, { title: `${bot.name} may ask`, bot, others, busy, has: id => view.may_ask.includes(id), onToggle: id => toggle(slug, id) }),
      h(Pairs, { title: `May ask ${bot.name}`, bot, others, busy, has: id => view.asked_by.includes(id), onToggle: id => toggle(id, slug) })) : null,
    view ? h('section', { className: 'a2a-side-card', 'aria-label': 'Open tasks' },
      h('strong', null, 'Open tasks'),
      cancelNote ? h('p', { className: 'a2a-faint', role: 'status' }, cancelNote) : null,
      h(Tasks, { tasks: view.tasks, onCancel: cancel, name })) : null,
    view ? h('section', { className: 'a2a-side-card', 'aria-label': 'Assigned to me' },
      h('strong', null, 'Assigned to me'),
      (view.assigned_to_me || []).length ? h('ul', { className: 'a2a-asgs' }, view.assigned_to_me.map(a => h('li', { key: a.id, className: 'a2a-asg' },
        h('div', { className: 'a2a-asg-head' }, h(Pill, { tone: STATUS_TONE[a.status] || 'info' }, STATUS_WORD[a.status] || a.status),
          h('span', { className: 'a2a-faint' }, `from ${name(a.by)} · ${ageText(a.age_secs)}`)),
        h('div', { className: 'a2a-peer' }, String(a.title || '')),
        a.last_note ? h('div', { className: 'a2a-peer' }, String(a.last_note)) : null)))
        : h('p', { className: 'a2a-faint' }, 'No assignments.')) : null,
    view ? h('section', { className: 'a2a-side-card', 'aria-label': 'Conversations' },
      h('strong', null, `Conversations (${plural(items.length, 'item')})`),
      h(Activity, { items: groupRows(view.rows), loading: false, error: null, onRetry: load, bots: view.bots, client, name,
        filter, setFilter, seen: { at: '9999', keys: [] }, markSeen: () => {}, arrived: new Set(), maxTurns: view.max_turns || 5,
        reasonFor: reasonText, now: Date.now() })) : null,
    dialog ? h(Confirm, { client, runId: dialog.runId, title: `Repair ${bot.name}`, plan: dialog.plan,
      onClose: changed => { setDialog(null); if (changed) load() }, onApplied: () => {} }) : null)
}
