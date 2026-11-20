// The Fleet tab (0.7): your other crews, which of your Bots may ask a Bot there, and which
// Bots there may ask yours. Edits go into the page's policy draft and are saved with the
// shared save bar. Whether peer calls can run at all is the backend's answer (GET /fleet):
// on a Kiro Crew with no peer seam, the tab says so and every peer call is refused.

import { useCallback, useEffect, useId, useState } from 'react'
import { API } from '../lib/api.mjs'
import { ago } from '../lib/feed.mjs'
import {
  PEER_CALLS_ISSUE, addPair, fleetOf, outPairProblem, pairRows, removeCrew, removePair, setCrew,
  validCrew, validInstance, validPeerKey, validSlug,
} from '../lib/fleet.mjs'
import { Button, Empty, ErrorBox, Icon, Pill, Section, Skeleton, h } from '../lib/ui.mjs'

function SeamNotice({ view }) {
  if (!view) return null
  if (view.seam) {
    return h('p', { className: 'a2a-healed', role: 'status' }, h(Icon, { name: 'CircleCheck', size: 14 }),
      ' Peer calls are available on this Kiro Crew.',
      view.gateway_id ? h('span', null, ' This crew\'s id: ', h('code', { className: 'a2a-mono' }, view.gateway_id)) : null)
  }
  return h('div', { className: 'a2a-nochat', role: 'status' },
    h('strong', null, h(Icon, { name: 'Unplug', size: 14 }), ' Fleet is off'),
    h('p', null, 'Fleet stays off until Kiro Crew ships app peer calls. Until then every call to a Bot on another crew is refused and nothing is sent. ',
      h('a', { href: PEER_CALLS_ISSUE, target: '_blank', rel: 'noopener noreferrer' }, 'Kiro Crew feature request #40040'), '.'),
    h('p', { className: 'a2a-faint' }, 'You can set up crews and pairs now. They take effect only once both crews run a Kiro Crew with app peer calls.'))
}

function Field({ label, value, onChange, placeholder, valid }) {
  const id = useId()
  return h('div', { className: 'a2a-limit' },
    h('label', { htmlFor: id }, label),
    h('input', { id, value, placeholder, spellCheck: false, 'aria-invalid': value && !valid ? true : undefined,
      onChange: e => onChange(e.target.value.trim()) }))
}

function Crews({ fleet, onChange }) {
  const [alias, setAlias] = useState('')
  const [inst, setInst] = useState('')
  const ok = validCrew(alias) && validInstance(inst)
  const rows = Object.entries(fleet.crews || {})
  return h(Section, { id: 'a2a-fleet-crews', title: 'Your other crews' },
    h('p', { className: 'a2a-faint' }, 'A short name for each Remote Crew this dashboard connects to (Settings → Remote Crew). A Bot there is then called <crew>/<bot>.'),
    rows.length ? h('ul', { className: 'a2a-list' }, rows.map(([a, i]) => h('li', { key: a, className: 'a2a-row-gap' },
      h('strong', null, a), h('span', { className: 'a2a-faint a2a-mono' }, i),
      h(Button, { kind: 'quiet', icon: 'X', 'aria-label': `Remove crew ${a}`, onClick: () => onChange(removeCrew(fleet, a)) }))))
      : h(Empty, { icon: 'Server', title: 'No other crews yet' }),
    h('div', { className: 'a2a-row-gap' },
      h(Field, { label: 'Crew name', value: alias, onChange: setAlias, placeholder: 'dev', valid: validCrew(alias) }),
      h(Field, { label: 'Remote Crew instance id', value: inst, onChange: setInst, placeholder: 'from Settings → Remote Crew', valid: validInstance(inst) }),
      h(Button, { icon: 'Plus', disabled: !ok, onClick: () => { onChange(setCrew(fleet, alias, inst)); setAlias(''); setInst('') } }, 'Add crew')))
}

function Pairs({ id, title, help, map, fleet, onChange, keyLabel, keyPlaceholder, keyValid, targetLabel, targetPlaceholder, targetValid, problem, bots }) {
  const [key, setKey] = useState('')
  const [target, setTarget] = useState('')
  const why = problem ? problem(key, target) : (!keyValid(key) || !targetValid(target) ? 'incomplete' : '')
  const rows = pairRows(fleet[map])
  return h(Section, { id, title },
    h('p', { className: 'a2a-faint' }, help),
    rows.length ? h('ul', { className: 'a2a-list' }, rows.map(r => h('li', { key: `${r.key}>${r.target}`, className: 'a2a-row-gap' },
      h('span', { className: 'a2a-mono' }, r.key), h(Icon, { name: 'ArrowRight', size: 14 }), h('span', { className: 'a2a-mono' }, r.target),
      h(Button, { kind: 'quiet', icon: 'X', 'aria-label': `Remove ${r.key} to ${r.target}`, onClick: () => onChange(removePair(fleet, map, r.key, r.target)) }))))
      : h(Empty, { icon: 'Network', title: 'No pairs yet' }),
    h('div', { className: 'a2a-row-gap' },
      bots ? h('div', { className: 'a2a-limit' },
        h('label', { htmlFor: `${id}-key` }, keyLabel),
        h('select', { id: `${id}-key`, value: key, onChange: e => setKey(e.target.value) },
          h('option', { value: '' }, 'Pick a Bot'), bots.map(b => h('option', { key: b.id, value: b.id }, b.name))))
        : h(Field, { label: keyLabel, value: key, onChange: setKey, placeholder: keyPlaceholder, valid: keyValid(key) }),
      h(Field, { label: targetLabel, value: target, onChange: setTarget, placeholder: targetPlaceholder, valid: targetValid(target) }),
      h(Button, { icon: 'Plus', disabled: !!why, onClick: () => { onChange(addPair(fleet, map, key, target)); setTarget('') } }, 'Add pair')),
    why && why !== 'incomplete' && key && target ? h('p', { className: 'a2a-warn-text' }, why) : null)
}

function PeerActivity({ rows, now }) {
  if (!rows.length) return h(Empty, { icon: 'Activity', title: 'No peer calls yet' })
  return h('ul', { className: 'a2a-list' }, rows.slice().reverse().slice(0, 30).map((r, i) => h('li', { key: i, className: 'a2a-row-gap' },
    h(Pill, { tone: r.outcome === 'completed' ? 'answered' : ['denied', 'rejected', 'refused'].includes(r.outcome) ? 'refused' : r.outcome === 'error' ? 'failed' : 'working' }),
    h('span', { className: 'a2a-mono' }, `${r.caller || r.hub || ''} → ${r.target || ''}`),
    r.reason ? h('span', { className: 'a2a-faint' }, r.reason) : null,
    h('span', { className: 'a2a-faint' }, ago(r.ts, now)))))
}

export default function Fleet({ client, draft, setDraft, bots, saveBar, now }) {
  const [view, setView] = useState(null)
  const [err, setErr] = useState(null)
  const load = useCallback(async () => {
    try { setView(await client.get(`${API}/fleet`)); setErr(null) } catch (e) { setErr(e) }
  }, [client])
  useEffect(() => { load() }, [load])
  if (!draft) return h(Skeleton, { rows: 3, label: 'Loading the fleet policy' })
  const fleet = fleetOf(draft)
  const onChange = f => setDraft({ ...draft, fleet: f })
  const roster = (bots || []).map(b => ({ id: b.id, name: b.name }))
  return h('div', { className: 'a2a-fleet' },
    err ? h(ErrorBox, { title: 'Could not read the fleet status', error: err, onRetry: load }) : h(SeamNotice, { view }),
    h('p', { className: 'a2a-faint' }, 'Only your own machines. A call needs a pair on both crews; a Bot asked from another crew answers only and cannot call a third crew. The smaller turn limit of the two crews applies.'),
    h(Crews, { fleet, onChange }),
    h(Pairs, { id: 'a2a-fleet-out', title: 'My Bots may ask Bots on another crew', map: 'allow_out', fleet, onChange, bots: roster,
      help: 'Your half of an outbound pair. The other crew must also allow it.',
      keyLabel: 'My Bot', keyValid: validSlug, targetLabel: 'Bot on the other crew', targetPlaceholder: 'dev/alice',
      targetValid: () => true, problem: (k, t) => outPairProblem(fleet, k, t) }),
    h(Pairs, { id: 'a2a-fleet-in', title: 'Bots on another crew may ask mine', map: 'allow_in', fleet, onChange,
      help: 'Your half of an inbound pair. The other crew is named by its crew id, which Kiro Crew proves on each call; the Bot name after the slash is that crew\'s word.',
      keyLabel: 'Their crew id / Bot', keyPlaceholder: 'gateway-id/alice', keyValid: validPeerKey,
      targetLabel: 'My Bot', targetPlaceholder: 'alice', targetValid: validSlug }),
    saveBar,
    h(Section, { id: 'a2a-fleet-activity', title: 'Peer activity' },
      view ? h(PeerActivity, { rows: view.rows || [], now }) : err ? null : h(Skeleton, { rows: 2, label: 'Loading peer activity' })))
}
