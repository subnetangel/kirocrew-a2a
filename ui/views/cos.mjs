// The Chief of Staff tab: who it is, the daily roll call, the escalation inbox, and
// assignments (settings, the approval queue and the list). Policy edits go into the page's
// draft and are saved with the shared save bar; queue and inbox actions post at once to
// owner-only routes. Every string a Bot wrote is shown as plain text (React text nodes),
// never as HTML or markdown.

import { useCallback, useEffect, useState } from 'react'
import { API } from '../lib/api.mjs'
import { KIND_WORD, MODE_HELP, OPEN, RESENDABLE, STATUS_TONE, STATUS_WORD, ageText, effectiveMode, groupAssignments, modeOptions, parseTerms, usesYolo } from '../lib/cos.mjs'
import { Button, Empty, ErrorBox, Icon, Pill, Section, Skeleton, h, plural } from '../lib/ui.mjs'

const POLL_MS = 15000

/** Text another Bot wrote: plain, fenced, wrapped. */
function Peer({ children, label }) {
  return h('div', { className: 'a2a-peer', 'aria-label': label || 'Text written by a Bot' }, String(children || ''))
}

function ModeSelect({ value, onChange, ceiling, allowDefault, id, label }) {
  return h('select', { id, value: value || '', 'aria-label': label, onChange: e => onChange(e.target.value) },
    allowDefault ? h('option', { value: '' }, 'Default') : null,
    modeOptions(ceiling).map(o => h('option', { key: o.id, value: o.id, disabled: o.disabled },
      o.disabled ? `${o.label} (blocked by policy)` : o.label)))
}

function YoloConfirm({ onConfirm, onCancel }) {
  return h('div', { className: 'a2a-yolo-confirm', role: 'alertdialog', 'aria-labelledby': 'a2a-yolo-h', 'aria-describedby': 'a2a-yolo-p' },
    h('strong', { id: 'a2a-yolo-h' }, 'Turn on YOLO for assignments?'),
    h('p', { id: 'a2a-yolo-p' }, 'Your Chief of Staff reads untrusted email and Slack. Text planted there could turn into real work that goes out with no review and no "ask first" line. The Bot that gets it still acts under its own approval mode.'),
    h('div', { className: 'a2a-row-gap' },
      h(Button, { onClick: onCancel }, 'Keep it off'),
      h(Button, { kind: 'danger', icon: 'TriangleAlert', onClick: onConfirm }, 'Turn on YOLO')))
}

/** One target's row: its status, its last note or reply, and the per-target actions. */
function TargetRow({ a, name, onAct, busy }) {
  const open = OPEN.has(a.status)
  return h('li', { className: 'a2a-asg-target' },
    h('div', { className: 'a2a-asg-head' },
      h('strong', null, name(a.target)),
      h(Pill, { tone: STATUS_TONE[a.status] || 'info' }, STATUS_WORD[a.status] || a.status),
      a.unread ? h('span', { className: 'a2a-tab-badge is-info' }, 'unread') : null),
    a.last_note ? h(Peer, { label: `Last note or reply from ${name(a.target)}` }, a.last_note) : null,
    h('div', { className: 'a2a-row-gap' },
      RESENDABLE.has(a.status) ? h(Button, { icon: 'RotateCw', disabled: busy, onClick: () => onAct(a, 'resend') }, 'Resend') : null,
      open && a.status !== 'queued' ? h(Button, { kind: 'quiet', icon: 'X', disabled: busy, onClick: () => onAct(a, 'cancel') }, 'Cancel') : null,
      a.unread ? h(Button, { kind: 'quiet', disabled: busy, onClick: () => onAct(a, 'seen') }, 'Mark seen') : null))
}

/** One item the owner decides on: a single assignment, or a broadcast to several Bots. */
function Assignment({ g, name, onAct, busy }) {
  const a = g.head
  const [editing, setEditing] = useState(false)
  const [edit, setEdit] = useState({ title: a.title, brief: a.brief, done_when: a.done_when })
  const waiting = a.status === 'queued'
  const modes = [...new Set(g.rows.map(r => r.mode))].join(', ')
  const targets = a.all ? `all Bots (${g.rows.length})` : g.rows.map(r => name(r.target)).join(', ')
  const apr = a.approval
  return h('li', { className: `a2a-asg ${g.rows.some(r => r.unread) ? 'is-unread' : ''}` },
    h('div', { className: 'a2a-asg-head' },
      waiting ? h(Pill, { tone: 'working' }, 'Waiting for you') : null,
      h('span', null, `${name(a.by)} to ${targets}`),
      h('span', { className: 'a2a-faint' }, `${KIND_WORD[a.kind] || a.kind} · mode ${modes} · ${ageText(a.age_secs)}`)),
    a.kind === 'instruction' ? h('p', { className: 'a2a-faint' },
      'Standing instruction: once you approve, each Bot is told it is your own approved instruction and follows it until you say otherwise. Irreversible steps still need your approval in that Bot.') : null,
    editing
      ? h('div', { className: 'a2a-asg-edit' },
        ['title', 'brief', 'done_when'].map(k => h('label', { key: k },
          h('span', null, k === 'done_when' ? 'Done when' : k[0].toUpperCase() + k.slice(1)),
          h(k === 'brief' ? 'textarea' : 'input', { value: edit[k], maxLength: { title: 120, brief: 2000, done_when: 300 }[k],
            rows: k === 'brief' ? 6 : undefined, onChange: e => setEdit({ ...edit, [k]: e.target.value }) }))))
      : h('div', null,
        waiting ? h('p', { className: 'a2a-faint' }, 'This is the exact text you approve. Its sha256 is recorded with your approval, and a2a refuses to send it if it changes.') : null,
        h('p', { className: 'a2a-faint' }, 'Title:'), h(Peer, { label: 'Title, written by the Chief of Staff' }, a.title),
        h('p', { className: 'a2a-faint' }, 'Brief:'), h(Peer, { label: 'Brief' }, a.brief),
        h('p', { className: 'a2a-faint' }, 'Done when:'), h(Peer, { label: 'Done when' }, a.done_when || '(not given)')),
    apr ? h('p', { className: 'a2a-faint' }, `Approved by you ${String(apr.at || '').replace('T', ' ').slice(0, 16)} UTC · ${apr.id} · sha256 ${String(apr.sha256 || '').slice(0, 12)}…`)
      : (!waiting ? h('p', { className: 'a2a-faint' }, `Sent without a per-item review (mode ${modes}).`) : null),
    waiting ? null : h('ul', { className: 'a2a-asg-targets', 'aria-label': 'Delivery per Bot' },
      g.rows.map(r => h(TargetRow, { key: r.id, a: r, name, onAct, busy }))),
    waiting ? h('div', { className: 'a2a-row-gap' },
      !editing ? [
        h(Button, { key: 'ap', kind: 'primary', icon: 'Check', disabled: busy, onClick: () => onAct(a, 'approve') },
          g.rows.length > 1 ? `Approve for ${g.rows.length} Bots` : 'Approve'),
        h(Button, { key: 'ed', icon: 'Pencil', disabled: busy, onClick: () => setEditing(true) }, 'Edit'),
        h(Button, { key: 'rj', icon: 'X', disabled: busy, onClick: () => onAct(a, 'reject') }, 'Reject')] : [
        h(Button, { key: 'sv', kind: 'primary', disabled: busy, onClick: async () => { await onAct(a, 'edit', edit); setEditing(false) } }, 'Save edit'),
        h(Button, { key: 'cx', onClick: () => setEditing(false) }, 'Keep as is')]) : null)
}

function Brief({ b, name }) {
  return h('details', { className: 'a2a-brief' },
    h('summary', null, `${b.ts.slice(0, 16).replace('T', ' ')} UTC · ${b.trigger === 'schedule' ? 'daily' : 'on request'} · ` +
      `${b.rows.filter(r => r.status === 'answered').length} of ${b.rows.length} answered` +
      (b.overlaps.length ? ` · ${plural(b.overlaps.length, 'overlap')}` : '')),
    h('p', { className: 'a2a-faint' }, 'Question: ', b.question),
    b.overlaps.length ? h('div', { className: 'a2a-overlaps' }, h('strong', null, 'Overlaps'),
      h('ul', null, b.overlaps.map(o => h('li', { key: o.id }, h('code', null, o.id), ` named by ${o.bots.map(name).join(', ')}`)))) : null,
    h('ul', { className: 'a2a-brief-rows' }, b.rows.map(r => h('li', { key: r.agent },
      h('strong', null, r.name || name(r.agent)), ' ',
      r.status === 'answered' ? h(Peer, null, r.text) : h(Pill, { tone: r.status === 'no-chat' ? 'info' : 'failed' }, r.status)))))
}

export default function ChiefOfStaff({ client, draft, setDraft, saved, name, saveBar }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [actErr, setActErr] = useState(null)
  const [yoloAsk, setYoloAsk] = useState(null)  // the draft waiting for the YOLO confirm
  const [terms, setTerms] = useState(null)
  const load = useCallback(async () => {
    try { setView(await client.get(`${API}/chief-of-staff`)); setError(null) } catch (e) { setError(e) }
  }, [client])
  useEffect(() => {
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  if (error && !view) return h(ErrorBox, { title: 'Could not load the Chief of Staff view', error, onRetry: load })
  if (!view || !draft) return h(Skeleton, { rows: 4, label: 'Loading the Chief of Staff view' })

  const bots = view.bots || []
  const ceiling = view.ceiling || { normal: true }
  const chief = draft.chief_of_staff || ''
  const sched = draft.rollcall_schedule || { enabled: false, time: '06:45', timezone: 'America/Chicago' }
  const set = patch => {
    const next = { ...draft, ...patch }
    if (usesYolo(next) && !usesYolo(saved) && !draft.confirm_yolo) { setYoloAsk(next); return }
    setDraft(next)
  }
  const act = async (path, body) => {
    setBusy(true); setActErr(null)
    try { await client.post(`${API}${path}`, body); await load() } catch (e) { setActErr(e) } finally { setBusy(false) }
  }
  const onAsg = (a, action, edits) => act(`/assignments/${encodeURIComponent(a.id)}`, { action, edits })
  const items = groupAssignments(view.assignments)
  const queued = items.filter(g => g.head.status === 'queued')
  const others = items.filter(g => g.head.status !== 'queued')
  const accepts = id => (draft.accepts_assignments || {})[id] !== false
  const savedYolo = usesYolo(saved)

  return h('div', { className: 'a2a-cos' },
    savedYolo ? h('div', { className: 'a2a-yolo-banner', role: 'alert' }, h(Icon, { name: 'TriangleAlert', size: 16 }),
      ' YOLO is on for assignments: they go out with no review and no "ask first" line. Text planted in what your Chief of Staff reads could become real work.') : null,
    actErr ? h(ErrorBox, { title: 'That action was refused', error: actErr }) : null,
    yoloAsk ? h(YoloConfirm, { onCancel: () => setYoloAsk(null), onConfirm: () => { setDraft({ ...yoloAsk, confirm_yolo: true }); setYoloAsk(null) } }) : null,

    h(Section, { id: 'a2a-cos-who', title: 'Chief of Staff' },
      h('div', { className: 'a2a-limits' },
        h('div', { className: 'a2a-limit' },
          h('label', { htmlFor: 'a2a-cos-pick' }, 'Your Chief of Staff'),
          h('select', { id: 'a2a-cos-pick', value: chief, onChange: e => set({ chief_of_staff: e.target.value || null }) },
            h('option', { value: '' }, 'None'), bots.map(b => h('option', { key: b.id, value: b.id }, b.name))),
          !chief && view.suggested ? h(Button, { kind: 'quiet', icon: 'Sparkles', onClick: () => set({ chief_of_staff: view.suggested }) },
            `Use ${name(view.suggested)}`) : null,
          h('p', { className: 'a2a-faint' }, 'Only this Bot may ask "all" Bots, ask more than the limit below, run a roll call, read the inbox, or assign work. None is set until you pick one.')),
        h('div', { className: 'a2a-limit' },
          h('label', { htmlFor: 'a2a-cos-fan' }, 'Bots per question for every other Bot'),
          h('input', { id: 'a2a-cos-fan', type: 'number', min: 1, max: 16, value: draft.fanout_others || 3,
            onChange: e => set({ fanout_others: Math.min(16, Math.max(1, Math.round(Number(e.target.value) || 1))) }) }),
          h('p', { className: 'a2a-faint' }, 'Default 3, 1 to 16. A longer list is refused, never trimmed.')),
        h('div', { className: 'a2a-limit' },
          h('label', { htmlFor: 'a2a-cos-owner' }, 'Your name in roll calls and assignments'),
          h('input', { id: 'a2a-cos-owner', type: 'text', maxLength: 40, value: draft.owner_name || '', placeholder: 'your owner',
            onChange: e => set({ owner_name: e.target.value }) })))),

    h(Section, { id: 'a2a-cos-roll', title: 'Roll call' },
      h('div', { className: 'a2a-limits' },
        h('div', { className: 'a2a-limit' },
          h('label', { className: 'a2a-offer' },
            h('input', { type: 'checkbox', checked: sched.enabled === true, disabled: !chief,
              onChange: e => set({ rollcall_schedule: { ...sched, enabled: e.target.checked } }) }),
            h('span', { className: 'a2a-label' }, 'Daily roll call')),
          h('p', { className: 'a2a-faint' }, 'Each roll call costs every Bot one turn. Off by default. The Chief of Staff can also run one with a2a_rollcall.')),
        h('div', { className: 'a2a-limit' },
          h('label', { htmlFor: 'a2a-cos-time' }, 'Time'),
          h('input', { id: 'a2a-cos-time', type: 'time', value: sched.time, onChange: e => set({ rollcall_schedule: { ...sched, time: e.target.value } }) }),
          h('label', { htmlFor: 'a2a-cos-tz' }, 'Time zone'),
          h('input', { id: 'a2a-cos-tz', type: 'text', value: sched.timezone, onChange: e => set({ rollcall_schedule: { ...sched, timezone: e.target.value } }) })),
        h('div', { className: 'a2a-limit' },
          h('label', { htmlFor: 'a2a-cos-terms' }, 'Project names to flag as overlaps'),
          h('textarea', { id: 'a2a-cos-terms', rows: 3, value: terms !== null ? terms : (draft.watch_terms || []).join('\n'),
            onChange: e => setTerms(e.target.value), onBlur: () => { if (terms !== null) { set({ watch_terms: parseTerms(terms) }); setTerms(null) } } }),
          h('p', { className: 'a2a-faint' }, 'One per line. Ticket ids, CRs and SIM-style ids are flagged anyway when two Bots name the same one.'))),
      view.rollcalls.length ? view.rollcalls.map(b => h(Brief, { key: b.id, b, name }))
        : h(Empty, { icon: 'ClipboardList', title: 'No roll calls yet' }, 'The latest 10 briefs show here.')),

    h(Section, { id: 'a2a-cos-inbox', title: `Inbox (${view.inbox.length})` },
      view.inbox.length ? h('ul', { className: 'a2a-inbox' }, view.inbox.map(i => h('li', { key: i.id },
        h('div', { className: 'a2a-asg-head' }, h('strong', null, name(i.caller)),
          h('span', { className: 'a2a-faint' }, `×${i.count} · last ${i.last_seen.slice(0, 16).replace('T', ' ')} UTC`)),
        h(Peer, { label: 'Title' }, i.title),
        i.why ? h(Peer, { label: 'Why' }, i.why) : null,
        i.ask ? h(Peer, { label: 'Ask' }, i.ask) : null,
        h('div', { className: 'a2a-row-gap' },
          h(Button, { icon: 'Check', disabled: busy, onClick: () => act(`/inbox/${encodeURIComponent(i.id)}`, { action: 'done' }) }, 'Done'),
          h(Button, { kind: 'quiet', disabled: busy, onClick: () => act(`/inbox/${encodeURIComponent(i.id)}`, { action: 'dismiss' }) }, 'Dismiss')))))
        : h(Empty, { icon: 'Inbox', title: 'Nothing escalated' }, 'Bots raise items with a2a_escalate.')),

    h(Section, { id: 'a2a-cos-asg', title: 'Assignments' },
      h('div', { className: 'a2a-limits' },
        h('div', { className: 'a2a-limit' },
          h('label', { className: 'a2a-offer' },
            h('input', { type: 'checkbox', checked: draft.cos_can_assign === true, disabled: !chief,
              onChange: e => set({ cos_can_assign: e.target.checked }) }),
            h('span', { className: 'a2a-label' }, 'Let the Chief of Staff assign work')),
          h('p', { className: 'a2a-faint' }, 'Off by default. The Bot that gets work uses only its own tools and approval mode; a2a never widens either.')),
        h('div', { className: 'a2a-limit' },
          h('label', { htmlFor: 'a2a-cos-mode' }, 'Approval for assignments'),
          h(ModeSelect, { id: 'a2a-cos-mode', value: draft.assign_mode_default || 'normal', ceiling, onChange: v => set({ assign_mode_default: v }) }),
          h('p', { className: 'a2a-faint' }, MODE_HELP[draft.assign_mode_default || 'normal'])),
        h('div', { className: 'a2a-limit' },
          h('label', { htmlFor: 'a2a-cos-open' }, 'Open assignments per Bot'),
          h('input', { id: 'a2a-cos-open', type: 'number', min: 1, max: 10, value: draft.max_open_assignments || 3,
            onChange: e => set({ max_open_assignments: Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 1))) }) }),
          h('p', { className: 'a2a-faint' }, 'Default 3, 1 to 10. One more is refused, not queued.'))),
      h('table', { className: 'a2a-cos-bots' },
        h('thead', null, h('tr', null, h('th', null, 'Bot'), h('th', null, 'Accepts work'), h('th', null, 'Approval'), h('th', null, 'In effect'))),
        h('tbody', null, bots.filter(b => b.id !== chief).map(b => h('tr', { key: b.id },
          h('th', { scope: 'row' }, b.name),
          h('td', null, h('input', { type: 'checkbox', 'aria-label': `${b.name} accepts assignments`, checked: accepts(b.id),
            onChange: e => {
              const m = { ...(draft.accepts_assignments || {}) }
              if (e.target.checked) delete m[b.id]; else m[b.id] = false
              set({ accepts_assignments: m })
            } })),
          h('td', null, h(ModeSelect, { value: (draft.assign_mode_by_bot || {})[b.id] || '', ceiling, allowDefault: true, label: `Approval for ${b.name}`,
            onChange: v => { const m = { ...(draft.assign_mode_by_bot || {}) }; if (v) m[b.id] = v; else delete m[b.id]; set({ assign_mode_by_bot: m }) } })),
          h('td', { className: 'a2a-faint' }, effectiveMode(draft, b.id, ceiling)))))),
      saveBar,
      h('h3', null, `Waiting for you (${queued.length})`),
      queued.length ? h('ul', { className: 'a2a-asgs' }, queued.map(g => h(Assignment, { key: g.id, g, name, onAct: onAsg, busy })))
        : h('p', { className: 'a2a-faint' }, 'Nothing waiting.'),
      h('h3', null, 'All assignments and instructions'),
      others.length ? h('ul', { className: 'a2a-asgs' }, others.map(g => h(Assignment, { key: g.id, g, name, onAct: onAsg, busy })))
        : h('p', { className: 'a2a-faint' }, 'None yet.'),
      h('p', { className: 'a2a-faint' }, 'Cancel stops a2a from following the work; it cannot stop a turn the Bot already started.')))
}
