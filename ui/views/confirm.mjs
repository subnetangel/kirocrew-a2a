// The review-then-apply dialog shared by the one-click setup and Repair. A native modal
// <dialog>: focus is trapped and Escape closes it, which this consequential action earns.
//
// The review belongs to the button press (runId), not to this component: reviewFor() is
// single-flight, so a re-render, a poll or a remount re-attaches to the running review.

import { useEffect, useRef, useState } from 'react'
import { commit, forgetReview, reviewFor, verify } from '../lib/apply.mjs'
import { Button, ErrorBox, Icon, Skeleton, h, plural } from '../lib/ui.mjs'

const STATE_WORD = { running: 'Applying', done: 'Checking it took effect', failed: 'Failed', skipped: 'Not done', verified: 'Applied', not_done: 'Not done' }
const CHECK_WORD = { pending: 'Waiting', checking: 'Checking', ready: 'Ready', failed: 'Preview failed', timeout: 'Timed out' }
const CHECK_ICON = { pending: 'Clock', checking: 'LoaderCircle', ready: 'Check', failed: 'TriangleAlert', timeout: 'TriangleAlert' }

function secs(ms) { return ms ? `${(ms / 1000).toFixed(1)} s` : '' }

export default function Confirm({ client, runId, title, plan, onClose, onApplied }) {
  const ref = useRef(null)
  const [, setTick] = useState(0)
  const [progress, setProgress] = useState({})
  const [phase, setPhase] = useState('review')
  const [outcome, setOutcome] = useState(null)
  const run = reviewFor(runId, client, plan)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open && typeof d.showModal === 'function') d.showModal()
    const off = run.subscribe(() => setTick(t => t + 1))
    // Elapsed time keeps moving for the Bots still being checked.
    const t = setInterval(() => { if (run.summary && !run.summary.settled) setTick(n => n + 1) }, 1000)
    return () => { off(); clearInterval(t) }
  }, [runId])

  const summary = run.summary
  const close = () => {
    if (phase === 'applying') return
    forgetReview(runId)
    onClose(phase === 'finished')
  }
  const apply = async () => {
    setPhase('applying')
    const done = {}
    await commit(client, summary.steps, (i, state, err) => {
      done[i] = state
      setProgress(p => ({ ...p, [i]: { state, error: err } }))
    })
    // Never report success from the calls alone: read every change back first.
    const checked = await verify(client, summary.steps, done)
    setProgress(p => Object.fromEntries(summary.steps.map((_, i) =>
      [i, { ...(p[i] || {}), state: checked.results[i].state, why: checked.results[i].why }])))
    setOutcome(checked)
    setPhase('finished')
    onApplied(checked.ok ? 0 : checked.results.filter(r => r.state !== 'verified').length)
  }
  const anyReady = summary && summary.steps.some(s => !s.state || s.state === 'ready')
  const ready = summary && summary.settled && !summary.needsApproval && anyReady

  return h('dialog', { ref, className: 'a2a-dialog', 'aria-labelledby': 'a2a-confirm-h',
    onCancel: e => { e.preventDefault(); close() } },
  h('header', null, h('h2', { id: 'a2a-confirm-h' }, title),
    h(Button, { kind: 'quiet', icon: 'X', 'aria-label': 'Close', onClick: close, disabled: phase === 'applying' })),
  h('div', { className: 'a2a-dialog-body' },
    run.error ? h(ErrorBox, { title: 'Could not prepare the changes', error: run.error }) : null,
    !summary && !run.error ? h(Skeleton, { rows: 4, label: 'Preparing the review' }) : null,
    summary && summary.needsApproval ? h(ErrorBox, { title: 'Approve the new permission first', error: summary.needsApproval }) : null,
    summary && !summary.steps.length ? h('p', null, 'Everything is already set up. Nothing to change.') : null,
    summary && summary.bots && !summary.settled ? h('p', { className: 'a2a-progress', role: 'status' },
      h(Icon, { name: 'LoaderCircle', className: 'a2a-spin' }),
      ` Checking ${summary.checking.join(', ') || 'Bots'}… ${summary.checked} of ${summary.bots} done`) : null,
    outcome ? (outcome.ok
      ? h('p', { className: 'a2a-done', role: 'status' }, h(Icon, { name: 'CircleCheck' }),
        ` All ${plural(outcome.results.length, 'step')} applied and read back from the dashboard.`)
      : h(ErrorBox, { title: `${plural(outcome.results.filter(r => r.state !== 'verified').length, 'step')} not done`,
        error: { message: 'Nothing below marked "Not done" took effect. Fix what each one says, then press Turn on A2A for all my Bots again.' } })) : null,
    !outcome && summary && summary.steps.length && summary.settled ? h('p', { className: 'a2a-faint' },
      phase === 'review'
        ? `Nothing has changed yet. Review these ${plural(summary.total, 'change')}, then apply. Each Bot's running workers pick up new tools at the end of their current turn.`
        : 'Applying in order. You can close this when it finishes.') : null,
    summary ? h('ol', { className: 'a2a-steps' }, summary.steps.map((s, i) => {
      const p = progress[i] || {}
      const check = s.kind === 'bot' ? s.state : null
      const elapsed = check === 'checking' ? Date.now() - s.started : s.elapsed
      return h('li', { key: i, className: `a2a-step is-${p.state || (check && check !== 'ready' ? (check === 'checking' || check === 'pending' ? 'pending' : 'blocked') : 'pending')}` },
        h('div', { className: 'a2a-step-head' },
          h('strong', null, s.title),
          p.state ? h('span', { className: 'a2a-step-state' },
            h(Icon, { name: p.state === 'verified' ? 'Check' : ['running', 'done'].includes(p.state) ? 'LoaderCircle' : 'TriangleAlert',
              className: ['running', 'done'].includes(p.state) ? 'a2a-spin' : '' }), STATE_WORD[p.state])
            : check ? h('span', { className: 'a2a-step-state' },
              h(Icon, { name: CHECK_ICON[check], className: check === 'checking' ? 'a2a-spin' : '' }),
              CHECK_WORD[check], elapsed ? h('span', { className: 'a2a-faint a2a-num' }, ` ${secs(elapsed)}`) : null) : null),
        s.command ? h('p', { className: 'a2a-mono a2a-faint a2a-wrap' }, s.command) : null,
        s.error && !s.error.permission ? h(ErrorBox, {
          title: check === 'timeout' ? 'The preview took too long; this Bot will be skipped unless you retry' : 'Preview refused, so this step will be skipped',
          error: s.error, onRetry: phase === 'review' ? () => run.retry(s) : null }) : null,
        s.error && s.error.permission ? h('p', { className: 'a2a-faint' }, 'Waiting for the permission above.') : null,
        s.lines.length ? h('details', { open: s.lines.length <= 8 },
          h('summary', null, plural(s.lines.length, 'change'), s.expands ? ` (${s.expands} allow a tool without asking)` : ''),
          h('ul', null, s.lines.map((l, j) => h('li', { key: j }, l)))) : null,
        p.state === 'not_done' ? h(ErrorBox, { title: 'Not done', error: p.error && p.error.message ? p.error : { message: p.why, permission: s.error && s.error.permission } }) : null)
    })) : null),
  h('footer', null,
    phase === 'finished'
      ? h(Button, { kind: 'primary', onClick: () => { forgetReview(runId); onClose(true) } }, outcome && outcome.ok ? 'Done' : 'Close')
      : [h(Button, { key: 'c', onClick: close, disabled: phase === 'applying' }, 'Cancel'),
        h(Button, { key: 'a', kind: 'primary', icon: 'Power', busy: phase === 'applying', disabled: !ready || phase === 'applying', onClick: apply },
          summary && summary.settled ? `Apply ${plural(summary.total, 'change')}` : 'Apply')]))
}
