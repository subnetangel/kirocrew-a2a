// Who may ask whom: a matrix of the owner's Bots. Rows ask, columns answer. One tab stop
// for the whole grid (roving focus): arrows move, Space or Enter toggles, Home/End jump in
// a row. Each row and each column has its own Allow all / none. Every edit goes through
// lib/matrix.mjs, which only touches pairs among the Bots shown, so a save keeps every
// pair that names someone else (an app, the owner, an agent listed under "Other agents").

import { Fragment, useMemo, useRef, useState } from 'react'
import { Button, Icon, h, plural } from '../lib/ui.mjs'
import { pairCount } from '../lib/feed.mjs'
import { setAll, setCol, setPair, setRow } from '../lib/matrix.mjs'

function Others({ others, onRemove, busy }) {
  const [asking, setAsking] = useState('')
  if (!others.length) return null
  return h('section', { className: 'a2a-others', 'aria-labelledby': 'a2a-others-h' },
    h('h3', { id: 'a2a-others-h' }, 'Other agents in the policy'),
    h('p', { className: 'a2a-faint' }, 'These are named in the policy but are not Bots on your roster (workers, conductors, an app\'s own agents). They are kept until you remove them.'),
    h('ul', null, others.map(o => h('li', { key: o.id },
      h('span', { className: 'a2a-mono' }, o.id), h('span', { className: 'a2a-faint a2a-num' }, plural(o.pairs, 'pair')),
      asking === o.id
        ? h('span', { className: 'a2a-row-gap' },
          h('span', null, `Remove ${o.id} and its ${plural(o.pairs, 'pair')}?`),
          h(Button, { kind: 'primary', busy, onClick: async () => { await onRemove(o.id); setAsking('') } }, 'Remove'),
          h(Button, { kind: 'quiet', onClick: () => setAsking('') }, 'Cancel'))
        : h(Button, { kind: 'quiet', icon: 'X', onClick: () => setAsking(o.id) }, 'Remove')))))
}

export default function Access({ bots, allow, onChange, savedAllow, others = [], onRemoveOther, removing }) {
  const ids = useMemo(() => bots.map(b => b.id), [bots])
  const bot = id => bots.find(b => b.id === id) || {}
  const name = id => bot(id).name || id
  const noChat = id => bot(id).chat === false
  const [focus, setFocus] = useState([0, 1])
  const [hover, setHover] = useState(null)
  const cells = useRef({})
  const total = ids.length * Math.max(0, ids.length - 1)
  const allowed = pairCount(allow, ids)
  const has = (a, b) => (allow[a] || []).includes(b)
  const changed = (a, b) => has(a, b) !== (savedAllow[a] || []).includes(b)
  const rowAll = a => ids.every(b => b === a || has(a, b))
  const rowNone = a => ids.every(b => b === a || !has(a, b))
  const colAll = b => ids.every(a => a === b || has(a, b))
  const colNone = b => ids.every(a => a === b || !has(a, b))

  const move = (r, c) => {
    const n = ids.length
    r = (r + n) % n
    c = (c + n) % n
    if (r === c) c = (c + 1) % n
    setFocus([r, c])
    const el = cells.current[`${r}:${c}`]
    if (el) el.focus()
  }
  const onKey = (e, r, c) => {
    const keys = {
      ArrowRight: () => move(r, c + 1 === r ? c + 2 : c + 1),
      ArrowLeft: () => move(r, c - 1 === r ? c - 2 : c - 1),
      ArrowDown: () => move(r + 1 === c ? r + 2 : r + 1, c),
      ArrowUp: () => move(r - 1 === c ? r - 2 : r - 1, c),
      Home: () => move(r, r === 0 ? 1 : 0),
      End: () => move(r, ids.length - 1 === r ? ids.length - 2 : ids.length - 1),
    }
    if (keys[e.key]) { e.preventDefault(); keys[e.key]() }
  }

  if (ids.length < 2) {
    return h(Fragment, null,
      h('p', { className: 'a2a-faint' }, 'A2A needs at least two of your Bots. Create a Bot, or open a Bot\'s chat once, and it appears here.'),
      h(Others, { others, onRemove: onRemoveOther, busy: removing }))
  }

  const [fr, fc] = focus
  const live = hover || (ids[fr] && ids[fc] ? [ids[fr], ids[fc]] : null)
  const lit = (a, b) => live && (live[0] === a || live[1] === b)

  return h('div', { className: 'a2a-access' },
    h('div', { className: 'a2a-access-bar' },
      h('p', null, h('strong', { className: 'a2a-num' }, allowed), ` of ${total} pairs allowed among ${plural(ids.length, 'Bot')}`),
      h('div', { className: 'a2a-row-gap' },
        h(Button, { onClick: () => onChange(setAll(allow, ids, true)), disabled: allowed === total }, 'Allow all'),
        h(Button, { onClick: () => onChange(setAll(allow, ids, false)), disabled: allowed === 0 }, 'Allow none'))),
    h('p', { className: 'a2a-access-read', 'aria-live': 'polite' },
      live ? [h('strong', { key: 'a' }, name(live[0])), has(live[0], live[1]) ? ' may ask ' : ' may not ask ', h('strong', { key: 'b' }, name(live[1])),
        noChat(live[1]) ? h('span', { key: 'n', className: 'a2a-faint' }, ` (${name(live[1])} has no chat yet, so it answers once you open it)`) : null]
        : 'Point at or focus a square to read it.'),
    h('div', { className: 'a2a-matrix-wrap' },
      h('table', { className: 'a2a-matrix', role: 'grid', 'aria-label': 'Who may ask whom. Rows ask, columns answer.' },
        h('thead', null, h('tr', null,
          h('td', { className: 'a2a-corner' }, h('span', null, 'Asks'), h(Icon, { name: 'ArrowRight', size: 12 }), h('span', null, 'answers')),
          ids.map(b => h('th', { key: b, scope: 'col', className: live && live[1] === b ? 'is-cross' : '' },
            h('span', { className: 'a2a-colname', title: name(b) }, name(b)),
            noChat(b) ? h('span', { className: 'a2a-nochat-tag' }, 'no chat') : null)),
          h('td', { className: 'a2a-rowtools-h' }, h('span', { className: 'a2a-sr' }, 'Whole row')))),
        h('tbody', null, ids.map((a, r) => h('tr', { key: a },
          h('th', { scope: 'row', className: live && live[0] === a ? 'is-cross' : '' },
            h('span', { className: 'a2a-rowname' }, name(a)),
            noChat(a) ? h('span', { className: 'a2a-nochat-tag' }, 'no chat') : null),
          ids.map((b, c) => {
            if (a === b) return h('td', { key: b, role: 'gridcell', 'aria-disabled': 'true' }, h('span', { className: 'a2a-self' }, h('span', { className: 'a2a-sr' }, `${name(a)} itself`)))
            const on = has(a, b)
            return h('td', { key: b, role: 'gridcell', className: lit(a, b) ? 'is-cross' : '' },
              h('button', {
                type: 'button', ref: el => { cells.current[`${r}:${c}`] = el },
                className: `a2a-cell ${on ? 'is-on' : ''} ${changed(a, b) ? 'is-changed' : ''}`,
                role: 'switch', 'aria-checked': on, 'aria-label': `${name(a)} may ask ${name(b)}`,
                tabIndex: fr === r && fc === c ? 0 : -1,
                onFocus: () => setFocus([r, c]), onKeyDown: e => onKey(e, r, c),
                onMouseEnter: () => setHover([a, b]), onMouseLeave: () => setHover(null),
                onClick: () => onChange(setPair(allow, a, b, !on)),
              }, on ? h(Icon, { name: 'Check', size: 16 }) : null))
          }),
          h('td', { className: 'a2a-rowtools' },
            h(Button, { kind: 'quiet', className: 'a2a-btn-sm', disabled: rowAll(a), 'aria-label': `${name(a)} may ask every Bot`, onClick: () => onChange(setRow(allow, ids, a, true)) }, 'All'),
            h(Button, { kind: 'quiet', className: 'a2a-btn-sm', disabled: rowNone(a), 'aria-label': `${name(a)} may ask no Bot`, onClick: () => onChange(setRow(allow, ids, a, false)) }, 'None'))))),
        h('tfoot', null, h('tr', null,
          h('th', { scope: 'row', className: 'a2a-faint' }, 'Whole column'),
          ids.map(b => h('td', { key: b, className: 'a2a-coltools' },
            h(Button, { kind: 'quiet', className: 'a2a-btn-sm', disabled: colAll(b), 'aria-label': `Every Bot may ask ${name(b)}`, onClick: () => onChange(setCol(allow, ids, b, true)) }, 'All'),
            h(Button, { kind: 'quiet', className: 'a2a-btn-sm', disabled: colNone(b), 'aria-label': `No Bot may ask ${name(b)}`, onClick: () => onChange(setCol(allow, ids, b, false)) }, 'None'))),
          h('td', null))))),
    h(Others, { others, onRemove: onRemoveOther, busy: removing }))
}
