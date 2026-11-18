// Pure helpers for the Chief of Staff tab (tested in tests/ui.test.mjs).

/** Kiro Crew's approval modes with the labels the page shows. */
export const MODES = [
  ['normal', 'Approve'],
  ['trust_reads', 'Trust reads'],
  ['trust', 'Trust'],
  ['yolo', 'YOLO'],
]

export const MODE_HELP = {
  normal: 'Every assignment waits here until you press Approve.',
  trust_reads: 'Read-only work (research, summaries, status checks) goes out at once; anything that changes things waits for Approve.',
  trust: 'Everything goes out at once and is marked unread here. Irreversible steps still need your own approval in that Bot.',
  yolo: 'Everything goes out at once with no notice, and the assignment no longer tells the Bot to ask you first. The Bot still works under its own approval mode.',
}

/** Mode options for a select, with the ones the host's ceiling denies disabled. */
export function modeOptions(ceiling) {
  return MODES.map(([id, label]) => ({ id, label, disabled: id !== 'normal' && !(ceiling && ceiling[id]) }))
}

/** The mode an assignment to *bot* would run under: per-Bot override, then default, then the ceiling. */
export function effectiveMode(policy, bot, ceiling) {
  const by = (policy && policy.assign_mode_by_bot) || {}
  const mode = by[bot] || (policy && policy.assign_mode_default) || 'normal'
  return mode === 'normal' || (ceiling && ceiling[mode]) ? mode : 'normal'
}

export function usesYolo(policy) {
  if (!policy) return false
  return policy.assign_mode_default === 'yolo' || Object.values(policy.assign_mode_by_bot || {}).includes('yolo')
}

/** Whether saving *draft* turns YOLO on, which needs the in-page confirm first. */
export function needsYoloConfirm(saved, draft) {
  return usesYolo(draft) && !usesYolo(saved) && !(draft && draft.confirm_yolo === true)
}

/** Watch terms from a textarea: one per line or comma, trimmed, de-duplicated, at most 50. */
export function parseTerms(text) {
  const out = []
  for (const raw of String(text || '').split(/[\n,]/)) {
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (t && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return out.slice(0, 50)
}

export function ageText(secs) {
  const s = Math.max(0, Number(secs) || 0)
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min`
  if (s < 129600) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86400)} d`
}

export const STATUS_TONE = {
  queued: 'working', sent: 'working', working: 'working', done: 'answered', blocked: 'failed',
  canceled: 'info', rejected: 'refused', stale: 'info', replied: 'info', no_reply: 'failed',
}

export const STATUS_WORD = {
  queued: 'Waiting for you', sent: 'Sent', working: 'Working', done: 'Done', blocked: 'Blocked',
  canceled: 'Canceled', rejected: 'Rejected', stale: 'Stale', replied: 'Replied, no update', no_reply: 'No reply',
}

export const OPEN = new Set(['queued', 'sent', 'working'])
