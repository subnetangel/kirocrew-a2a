// a2a dashboard page. Native ESM, no build step: React, lucide-react and the app SDK come
// from the host's import map. Every request goes through useAppApi() with the signed-in
// owner's session (lib/api.mjs). Writes: the app's owner-only PUT /policy, and, only after
// the owner confirms a reviewed list, the host's own bot-grants and capability routes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API, useClient, useNav } from './lib/api.mjs'
import { ago, groupRows, pairCount, reasonText } from './lib/feed.mjs'
import { Button, ErrorBox, Icon, Skeleton, h, plural, usePersisted, useStyles } from './lib/ui.mjs'
import Access from './views/access.mjs'
import Activity from './views/activity.mjs'
import Confirm from './views/confirm.mjs'
import Health from './views/health.mjs'
import Limits from './views/limits.mjs'
import Setup, { setupState } from './views/setup.mjs'
import { TabList, TabPanel, tabFromUrl, writeTab } from './views/tabs.mjs'
import { removeAgent } from './lib/matrix.mjs'

const ICON = new URL('./icon.png', import.meta.url).href
const POLL_MS = 10000
// The open review dialog outlives a remount of this page: the review it shows belongs to
// one button press (runId), so a host re-render cannot restart it.
let openDialog = null
const newRunId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function readFilter() {
  try {
    const q = new URLSearchParams(window.location.search)
    return { bot: q.get('bot') || '', outcome: q.get('outcome') || '', op: q.get('op') || '', since: q.get('since') || '24h' }
  } catch { return { bot: '', outcome: '', op: '', since: '24h' } }
}

function writeFilter(f) {
  try {
    const q = new URLSearchParams(window.location.search)
    for (const k of ['bot', 'outcome', 'op']) f[k] ? q.set(k, f[k]) : q.delete(k)
    f.since && f.since !== '24h' ? q.set('since', f.since) : q.delete('since')
    const s = q.toString()
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`)
  } catch { /* not a browser */ }
}

function useAudit(client) {
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    try {
      const a = await client.get(`${API}/audit?limit=400`)
      setRows(a.rows || []); setError(null)
    } catch (e) { setError(e) } finally { setLoading(false) }
  }, [client])
  useEffect(() => {
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, POLL_MS)
    const vis = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis) }
  }, [load])
  return { rows, error, loading, reload: load }
}

function Status({ setup, policy, bots, lastSend, now, needRepair, setupErr }) {
  const ids = bots.map(b => b.id)
  const total = ids.length * Math.max(0, ids.length - 1)
  const pairs = policy ? pairCount(policy.allow || {}, ids) : 0
  const item = (label, value, tone) => h('div', { className: `a2a-stat ${tone ? `is-${tone}` : ''}` }, h('dt', null, label), h('dd', null, value))
  return h('dl', { className: 'a2a-status' },
    item('A2A', setupErr ? 'Not running' : setup ? 'On' : 'Checking', setupErr ? 'bad' : setup ? 'ok' : ''),
    item('Version', setup ? setup.version || 'unknown' : '…'),
    item('Bots that can answer', setup ? `${bots.filter(b => b.chat !== false).length} of ${ids.length}` : '…'),
    item('Pairs allowed', policy ? `${pairs} of ${total}` : '…'),
    item('Last exchange', lastSend ? ago(lastSend, now) : 'none yet'),
    item('Health', setup ? (needRepair ? `${plural(needRepair, 'Bot')} need repair` : 'All mounted') : '…', setup ? (needRepair ? 'bad' : 'ok') : ''))
}

export default function A2APage() {
  const client = useClient()
  const navigate = useNav()
  const [setup, setSetup] = useState(null)
  const [setupErr, setSetupErr] = useState(null)
  const [saved, setSaved] = useState(null)
  const [draft, setDraft] = useState(null)
  const [policyErr, setPolicyErr] = useState(null)
  const [saving, setSaving] = useState(false)
  const [grants, setGrants] = useState(null)
  const [dialog, setDialogState] = useState(() => openDialog)
  const setDialog = d => { openDialog = d; setDialogState(d) }
  const [orchAll, setOrchAll] = useState(true)
  const [lastTab, setLastTab] = usePersisted('tab', 'activity')
  const [tab, setTabState] = useState(() => tabFromUrl(lastTab))
  const setTab = t => { setTabState(t); setLastTab(t); writeTab(t) }
  const [removing, setRemoving] = useState(false)
  const [filter, setFilterState] = useState(readFilter)
  const [seen, setSeen] = usePersisted('seen', { at: '', keys: [] })
  const [arrived, setArrived] = useState(() => new Set())
  const [now, setNow] = useState(Date.now())
  const known = useRef(null)
  const audit = useAudit(client)
  useStyles(setup && setup.version)

  const loadSetup = useCallback(async () => {
    try { setSetup(await client.get(`${API}/setup`)); setSetupErr(null) } catch (e) { setSetupErr(e) }
    try { const g = await client.botGrants(); setGrants(g.bots || []) } catch { setGrants(null) }
  }, [client])
  const loadPolicy = useCallback(async () => {
    try { const p = await client.get(`${API}/policy`); setSaved(p); setDraft(p); setPolicyErr(null) } catch (e) { setPolicyErr(e) }
  }, [client])
  useEffect(() => { loadSetup(); loadPolicy() }, [loadSetup, loadPolicy])
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t) }, [])

  const bots = (setup && setup.bots) || []
  const name = useCallback(id => {
    if (!id) return ''
    if (id === 'owner') return 'You'
    const b = bots.find(x => x.id === id)
    return b ? b.name : id.startsWith('app:') ? `app ${id.slice(4)}` : id
  }, [bots])
  const items = useMemo(() => groupRows(audit.rows), [audit.rows])

  // The departures-board move: an item that appears while the page is open is "arrived"
  // (it slides in once) and stays "new" until it is opened or marked seen.
  useEffect(() => {
    if (audit.loading) return
    const keys = items.map(i => i.key)
    if (known.current === null) {
      known.current = new Set(keys)
      if (!seen.at && items[0]) setSeen({ at: items[0].last, keys: [] })
      return
    }
    const fresh = keys.filter(k => !known.current.has(k))
    fresh.forEach(k => known.current.add(k))
    if (fresh.length) setArrived(new Set(fresh))
  }, [items, audit.loading])
  const markSeen = keys => {
    if (keys === null) setSeen({ at: items[0] ? items[0].last : seen.at, keys: [] })
    else setSeen({ at: seen.at, keys: [...new Set([...seen.keys, ...keys])].slice(-200) })
  }
  const setFilter = f => { setFilterState(f); writeFilter(f) }

  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)
  const save = async () => {
    setSaving(true)
    try { const p = await client.put(`${API}/policy`, draft); setSaved(p); setDraft(p); setPolicyErr(null); loadSetup(); audit.reload() } catch (e) { setPolicyErr(e) } finally { setSaving(false) }
  }

  // Drop an agent that is not on the roster from the policy, after the owner confirms in place.
  const removeOther = async id => {
    setRemoving(true)
    try {
      const base = draft || saved
      const p = await client.put(`${API}/policy`, { ...base, allow: removeAgent(base.allow || {}, id) })
      setSaved(p); setDraft(dirty ? { ...draft, allow: removeAgent(draft.allow || {}, id) } : p); setPolicyErr(null); loadSetup(); audit.reload()
    } catch (e) { setPolicyErr(e) } finally { setRemoving(false) }
  }
  const state = setup && saved ? setupState(setup, grants, (saved.orchestrate || {}).max_bots || 0) : null
  const needRepair = setup ? setup.bots.filter(b => b.health && !b.health.ok).length : 0
  const lastSend = (items.find(i => i.kind !== 'event') || {}).last
  const manual = bots.filter(b => !b.owned)
  const startSetup = () => setDialog({ runId: newRunId(), title: 'Turn on A2A for all my Bots', plan: {
    setup, policy: saved, grants, want: { policy: true, grants: true, bots: bots.filter(b => b.ops.length).map(b => b.id),
      orchAll: orchAll && state ? state.allBots : 0 } } })
  const repair = ids => setDialog({ runId: newRunId(), title: ids.length === 1 ? `Repair ${name(ids[0])}` : `Repair ${plural(ids.length, 'Bot')}`,
    plan: { setup, policy: saved, grants, want: { policy: false, grants: false, bots: ids } } })
  // The Bot's page in Members, where its chat opens; the first open creates its thread.
  const openBot = b => navigate && navigate(`/members?member=${encodeURIComponent(b.agent || b.name)}`)
  const closeDialog = changed => { setDialog(null); if (changed) { loadSetup(); loadPolicy(); audit.reload() } }

  const saveBar = dirty || (policyErr && draft) ? h('div', { className: 'a2a-savebar', role: 'region', 'aria-label': 'Unsaved policy changes' },
    policyErr && draft ? h(ErrorBox, { title: 'Save refused', error: policyErr }) : null,
    h('p', null, h(Icon, { name: 'Info', size: 14 }), ' Unsaved changes to who may ask whom or limits.'),
    h('div', { className: 'a2a-row-gap' },
      h(Button, { onClick: () => { setDraft(saved); setPolicyErr(null) }, disabled: saving }, 'Discard'),
      h(Button, { kind: 'primary', icon: 'Check', busy: saving, onClick: save, disabled: !dirty }, 'Save policy'))) : null
  const policyLoading = !draft || !setup
    ? (setupErr || (policyErr && !draft) ? null : h(Skeleton, { rows: 4, label: 'Loading the policy' })) : null
  const badges = {
    health: setup && needRepair ? { text: String(needRepair), tone: 'bad' } : null,
    access: dirty ? { text: 'unsaved', tone: 'info' } : null,
  }

  return h('div', { className: 'a2a' },
    h('header', { className: 'a2a-top' },
      h('div', { className: 'a2a-title' },
        h('img', { src: ICON, width: 36, height: 36, alt: '' }),
        h('div', null,
          h('h1', null, 'A2A: Bots ask each other'),
          h('p', null, 'Who may ask whom, how far a conversation may go, and every exchange. A Bot that is asked answers and changes nothing.'))),
      h(Status, { setup, policy: saved, bots, lastSend, now, needRepair, setupErr })),
    setupErr ? h(ErrorBox, { title: 'The a2a backend did not answer', error: setupErr, onRetry: loadSetup }) : null,
    state && !state.complete ? h(Setup, { state, onStart: startSetup, manual, noChat: setup.no_chat || [], onOpenChat: openBot, pythonOk: setup.python_ok, python: setup.python,
      maxBots: (saved.orchestrate || {}).max_bots || 4, orchAll, setOrchAll }) : null,
    h(TabList, { tab, onSelect: setTab, badges }),
    h(TabPanel, { id: 'activity', tab },
      h(Activity, { items, loading: audit.loading, error: audit.error, onRetry: audit.reload, bots, client, name,
        filter, setFilter, seen, markSeen, arrived, maxTurns: saved ? saved.max_turns_per_context : 5, reasonFor: reasonText, now })),
    h(TabPanel, { id: 'access', tab },
      policyErr && !draft ? h(ErrorBox, { title: 'Could not load the policy', error: policyErr, onRetry: loadPolicy }) : null,
      policyLoading || h(Access, { bots, allow: draft.allow || {}, savedAllow: saved.allow || {}, onChange: allow => setDraft({ ...draft, allow }),
        others: setup.other_agents || [], onRemoveOther: removeOther, removing }),
      saveBar),
    h(TabPanel, { id: 'limits', tab },
      draft ? h(Limits, { policy: draft, onChange: setDraft, allBots: Math.min(16, Math.max(1, bots.length - 1)) }) : h(Skeleton, { rows: 3, label: 'Loading limits' }),
      saveBar),
    h(TabPanel, { id: 'health', tab },
      setup ? h(Health, { setup, grants, onRepair: repair, onOpenBot: openBot })
        : setupErr ? null : h(Skeleton, { rows: 3, label: 'Checking each Bot' })),
    dialog ? h(Confirm, { client, runId: dialog.runId, title: dialog.title, plan: dialog.plan, onClose: closeDialog, onApplied: () => {} }) : null)
}
