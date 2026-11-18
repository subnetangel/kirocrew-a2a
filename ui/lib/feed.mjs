// Pure helpers for the activity feed: turn audit rows into conversations and runs,
// classify outcomes, and word refusals. No React, no DOM, so node can test them.

export const STALE_MS = 15 * 60 * 1000

/** Outcome class: what a row means to the owner, not the raw word. */
const CLASS = {
  completed: 'answered',
  delivering: 'working', started: 'working', queued: 'working', working: 'working',
  denied: 'refused', rejected: 'refused', busy: 'refused', duplicate: 'refused',
  timeout: 'failed', error: 'failed',
  updated: 'info', seeded: 'info', moved: 'info',
}

export const OUTCOMES = [
  ['answered', 'Answered'], ['refused', 'Refused'], ['failed', 'Failed'], ['working', 'In progress'],
]
export const OPS = [['send', 'Questions'], ['orchestrate', 'Orchestrations'], ['policy', 'Policy and setup']]

export function outcomeClass(outcome) {
  return CLASS[outcome] || 'info'
}

const REASONS = {
  policy: 'Not allowed by your who-may-ask-whom settings',
  unknown_target: 'No Bot by that name, or it has no chat thread to answer in',
  inside_peer_message: 'The Bot was answering another Bot, and may not start a question of its own',
  injection_screen: 'The message was flagged by the untrusted-text screen',
  context_busy: 'A turn on this conversation was still open',
  caller_unidentified: 'a2a could not tell which Bot sent the request',
}

/** One plain sentence for why a row was refused or failed. */
export function reasonText(row) {
  const r = String(row.reason || '')
  if (REASONS[r]) return REASONS[r]
  if (r.startsWith('loop_cap')) {
    const m = r.match(/(\d+)\/(\d+)/)
    return m ? `Reached the limit of ${m[2]} turns for one conversation` : 'Reached the turn limit'
  }
  if (r.startsWith('too_many')) {
    const m = r.match(/(\d+)\/(\d+)/)
    return m ? `Asked ${m[1]} Bots; the limit is ${m[2]}` : 'Asked more Bots than the limit'
  }
  if (r === 'stale') return 'No outcome was recorded; the send was refused or cut off'
  if (r.startsWith('writer_unverified')) return 'a2a could not verify which session wrote the request'
  if (row.outcome === 'busy') return 'The Bot stayed busy, so nothing was sent'
  if (row.outcome === 'duplicate') return 'The same question was already open, so it was not sent twice'
  if (row.outcome === 'timeout') return 'No answer in time'
  if (row.outcome === 'error') return row.error ? `Delivery failed: ${row.error}` : 'Delivery failed'
  if (row.outcome === 'queued') return 'The Bot was busy; its answer lands in its own chat only'
  return r
}

function targetsOf(row) {
  if (row.target) return [row.target]
  return String(row.targets || '').split(',').filter(Boolean)
}

/**
 * Group audit rows (oldest first, as the server returns them) into feed items,
 * newest first. A conversation is every row on one context; an orchestration run
 * gathers its contexts; a row with neither (a refusal before any context, a policy
 * change) stands alone.
 */
export function groupRows(rows) {
  const runOfCtx = new Map()
  for (const r of rows) if (r.context && r.run) runOfCtx.set(r.context, r.run)
  const items = new Map()
  rows.forEach((r0, i) => {
    // The outbox's "call" is a send that was refused before it reached the core.
    const r = r0.op === 'call' ? { ...r0, op: 'send' } : r0
    const run = r.run || (r.context && runOfCtx.get(r.context)) || ''
    const key = run ? `run:${run}` : r.context ? `ctx:${r.context}` : `row:${i}`
    let it = items.get(key)
    if (!it) {
      const asked = r.op === 'send' || r.op === 'orchestrate'
      it = { key, kind: run ? 'run' : r.context ? 'conversation' : asked ? 'single' : 'event', run, contexts: [], rows: [],
        op: r.op, caller: '', targets: [], first: r.ts || '', last: r.ts || '' }
      items.set(key, it)
    }
    it.rows.push(r)
    if (r.op === 'orchestrate') it.op = 'orchestrate'
    if (r.context && !it.contexts.includes(r.context)) it.contexts.push(r.context)
    it.caller = it.caller || r.caller || r.by || ''
    for (const t of targetsOf(r)) if (!it.targets.includes(t)) it.targets.push(t)
    if (r.ts && r.ts > it.last) it.last = r.ts
  })
  const out = [...items.values()].map(summarize)
  out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
  return out
}

function summarize(it) {
  const turns = it.rows.filter(r => r.outcome === 'delivering').length
  const final = [...it.rows].reverse().find(r => !['delivering', 'started'].includes(r.outcome)) || it.rows[it.rows.length - 1]
  let cls = outcomeClass(final.outcome)
  // A send with no outcome long after any delivery could still be running (the gateway
  // gives up at 10 minutes) was refused or cut off: it is failed, never "in progress".
  const stale = final.outcome === 'delivering' && Date.now() - Date.parse(final.ts || 0) > STALE_MS
  if (it.kind === 'run') {
    const classes = it.rows.filter(r => r.op === 'send').map(r => outcomeClass(r.outcome))
    const done = it.rows.some(r => r.op === 'orchestrate' && r.outcome === 'completed')
    if (it.rows.some(r => r.op === 'orchestrate' && r.outcome === 'denied')) cls = 'refused'
    else if (!done) cls = 'working'
    else if (classes.includes('answered')) cls = 'answered'
    else cls = classes.includes('failed') ? 'failed' : classes.includes('refused') ? 'refused' : 'answered'
  }
  if (stale && it.kind !== 'run') cls = 'failed'
  const refusal = it.rows.find(r => ['refused', 'failed'].includes(outcomeClass(r.outcome)))
  const reason = refusal ? reasonText(refusal) : stale ? 'No outcome was recorded; the send was refused or cut off' : ''
  return { ...it, turns, final, cls, reason }
}

export const SINCE = [['24h', 'Last 24 hours', 24 * 3600 * 1000], ['7d', 'Last 7 days', 7 * 24 * 3600 * 1000], ['all', 'All time', 0]]

/** Filter feed items by Bot (caller or target), outcome class, op and age (*since*). */
export function filterItems(items, { bot = '', outcome = '', op = '', since = '24h' } = {}, now = Date.now()) {
  const window = (SINCE.find(s => s[0] === since) || SINCE[0])[2]
  return items.filter(it =>
    (!window || now - Date.parse(it.last || 0) <= window) &&
    (!bot || it.caller === bot || it.targets.includes(bot)) &&
    (!outcome || it.cls === outcome) &&
    (!op || (op === 'policy' ? !['send', 'orchestrate'].includes(it.op) : it.op === op)))
}

/**
 * Fold runs of consecutive items (newest first) that failed or were refused the same
 * way, same caller, same target and same reason, into one item with ``repeats``: the
 * folded items, newest first. Answers, work in progress and runs are never folded.
 */
export function collapseRepeats(items) {
  const out = []
  const sig = it => (['failed', 'refused'].includes(it.cls) && it.kind !== 'run' && it.kind !== 'event')
    ? [it.cls, it.caller, it.targets.join(','), it.reason].join('|') : ''
  for (const it of items) {
    const prev = out[out.length - 1]
    const key = sig(it)
    if (prev && key && sig(prev) === key) {
      prev.repeats = prev.repeats || [{ ...prev }]
      prev.repeats.push(it)
      prev.first = it.first || it.last
      continue
    }
    out.push({ ...it })
  }
  return out
}

export function counts(items) {
  const c = {}
  for (const it of items) c[it.cls] = (c[it.cls] || 0) + 1
  return c
}

/** "3 min ago" from an ISO time, against *now* (ms). */
export function ago(ts, now = Date.now()) {
  const t = Date.parse(ts || '')
  if (!t) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export function clock(ts) {
  const t = Date.parse(ts || '')
  if (!t) return ''
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Count of allowed pairs among *ids*. */
export function pairCount(allow, ids) {
  const set = new Set(ids)
  let n = 0
  for (const a of ids) for (const b of allow[a] || []) if (b !== a && set.has(b)) n++
  return n
}
