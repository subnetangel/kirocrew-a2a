// The one-click setup and Repair, as a plan the owner reviews before anything changes.
//
// prepare() only reads and previews: it asks the host for each Bot's capability view,
// then for a preview of the a2a operations, which returns the impact rows and a
// preview_token and writes nothing. commit() runs only after the owner confirms the
// list, in order: policy, Bot access, then each Bot's tools, each through the host's
// own owner routes with the owner's session.
//
// A review runs exactly once per button press: reviewFor(runId) is single-flight, so a
// re-render, a poll or a remount of the dialog re-attaches to the same run instead of
// starting another. Previews run at most PREVIEW_CAP at a time, each with its own timeout.

// One at a time: on a loaded gateway, parallel previews all ran into its 20 s read deadline.
export const PREVIEW_CAP = 1
export const RETRY_503 = 2
export const RETRY_DELAY_MS = 5000
export const PREVIEW_TIMEOUT_MS = 75000

const SECTION_WORDS = {
  mcpServers: 'MCP server', tools: 'tools enabled', allowedTools: 'tool allowed without asking', autoApprove: 'auto-approve',
}

export function impactLine(row) {
  const what = SECTION_WORDS[row.section] || row.section
  const verb = row.change === 'added' ? 'Add' : row.change === 'removed' ? 'Remove' : 'Change'
  return `${verb} ${what}: ${row.id}`
}

class TimeoutError extends Error {
  constructor(ms) { super(`No answer from the dashboard in ${Math.round(ms / 1000)} s`); this.name = 'TimeoutError' }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** *fn()* again after a 503 (the host's capabilities_unavailable), *retries* times. */
export async function with503Retry(fn, { retries = RETRY_503, delayMs = RETRY_DELAY_MS, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn() } catch (e) {
      if (!(e && e.status === 503) || attempt >= retries || (signal && signal.aborted)) throw e
      await sleep(delayMs)
    }
  }
}

/** Preview one Bot's a2a changes into *step*, in place. Never throws. */
export async function previewBot(client, step, { timeoutMs = PREVIEW_TIMEOUT_MS, signal, onUpdate = () => {}, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const bot = step.bot
  const ctl = new AbortController()
  const stop = () => ctl.abort()
  if (signal) signal.addEventListener('abort', stop, { once: true })
  let timer
  Object.assign(step, { state: 'checking', started: Date.now(), error: null, lines: [], body: null })
  onUpdate()
  try {
    const work = (async () => {
      const init = { signal: ctl.signal }
      const retry = { delayMs: retryDelayMs, signal: ctl.signal }
      const view = await with503Retry(() => client.capabilities(bot.agent, init), retry)
      const body = { revision: view.revision, operations: bot.ops }
      const preview = await with503Retry(() => client.previewCapabilities(bot.agent, body, init), retry)
      return { body, preview }
    })()
    // The deadline covers the retries too: 3 tries of the host's 20 s read plus 2 waits.
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new TimeoutError(timeoutMs)) }, timeoutMs) })
    const { body, preview } = await Promise.race([work, timeout])
    step.body = { ...body, preview_token: preview.preview_token }
    step.lines = (preview.impact || []).map(impactLine)
    step.expands = (preview.impact || []).filter(r => r.approval_expanded).length
    const mount = bot.ops.find(o => o.section === 'mcpServers')
    if (mount) step.command = [mount.value.command, ...(mount.value.args || [])].join(' ')
    if (!step.lines.length) step.lines = ['Nothing to change: the host reports this Bot already matches']
    step.state = 'ready'
  } catch (e) {
    step.error = e
    step.state = e instanceof TimeoutError ? 'timeout' : 'failed'
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', stop)
    step.elapsed = Date.now() - step.started
    onUpdate()
  }
  return step
}

/** Run *jobs* (functions returning promises) at most *cap* at a time. */
async function pool(jobs, cap) {
  let next = 0
  const worker = async () => { while (next < jobs.length) { const j = jobs[next++]; await j() } }
  await Promise.all(Array.from({ length: Math.min(cap, jobs.length) }, worker))
}

export function summarize(steps) {
  const bots = steps.filter(s => s.kind === 'bot')
  const total = steps.reduce((n, s) => n + (s.state && s.state !== 'ready' ? 0 : s.lines.length), 0)
  const blocked = steps.find(s => s.error && s.error.permission)
  return {
    steps, total,
    // A permission still waiting for approval blocks the whole run: applying the rest
    // would leave the Bots half set up.
    needsApproval: blocked ? blocked.error : null,
    checked: bots.filter(s => !['pending', 'checking'].includes(s.state)).length,
    bots: bots.length,
    checking: bots.filter(s => s.state === 'checking').map(s => s.bot.name),
    settled: bots.every(s => !['pending', 'checking'].includes(s.state)),
  }
}

/**
 * Build the reviewed plan. *want*: { policy, grants, bots: [ids], orchAll }.
 * Resolves to summarize(steps); onUpdate(summary) fires on every change.
 */
export async function prepare(client, { setup, policy, grants, want },
  { cap = PREVIEW_CAP, timeoutMs = PREVIEW_TIMEOUT_MS, signal, onUpdate = () => {}, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const steps = []
  const orch = policy.orchestrate || {}
  const raise = want.orchAll && want.orchAll > (orch.max_bots || 0) ? want.orchAll : 0
  if ((want.policy && !setup.policy.complete) || raise) {
    const pairs = want.policy && !setup.policy.complete
    steps.push({ kind: 'policy', title: pairs ? 'Let every Bot ask every other Bot' : 'Let one question reach all your Bots',
      lines: [...(pairs ? setup.policy.missing_pairs.map(([a, b]) => `${a} may ask ${b}`) : []),
        ...(raise ? [`Bots per orchestration: ${orch.max_bots || 'default'} to ${raise} (all your Bots)`] : [])],
      body: { ...policy, allow: pairs ? setup.policy.proposed_allow : policy.allow,
        ...(raise ? { orchestrate: { ...orch, max_bots: raise } } : {}) } })
  }
  if (want.grants) {
    const ids = setup.bots.map(b => b.id)
    const have = new Set(grants || [])
    const add = ids.filter(id => !have.has(id))
    if (add.length) {
      steps.push({ kind: 'grants', title: 'Tick every Bot under "Bots this app can reach"',
        lines: add.map(id => `Tick ${id}`), body: [...new Set([...(grants || []), ...ids])].sort() })
    }
  }
  for (const id of want.bots || []) {
    const bot = setup.bots.find(b => b.id === id)
    if (bot && bot.ops.length) steps.push({ kind: 'bot', bot, title: `Mount a2a on ${bot.name}`, lines: [], state: 'pending' })
  }
  const emit = () => onUpdate(summarize(steps))
  emit()
  await pool(steps.filter(s => s.kind === 'bot').map(s => () =>
    signal && signal.aborted ? Promise.resolve() : previewBot(client, s, { timeoutMs, signal, onUpdate: emit, retryDelayMs })), cap)
  return summarize(steps)
}

// ------------------------------------------------------- one review per button press

const reviews = new Map()

/**
 * The review for *runId*, started on first call and shared after. Calling it again
 * (a re-render, a remount, a poll) returns the same run: nothing is previewed twice.
 * run = { summary, done, subscribe(fn), retry(step), abort() }
 */
export function reviewFor(runId, client, plan, opts = {}) {
  let run = reviews.get(runId)
  if (run) return run
  const ctl = new AbortController()
  const listeners = new Set()
  run = {
    summary: null, error: null,
    subscribe(fn) { listeners.add(fn); if (run.summary || run.error) fn(run); return () => listeners.delete(fn) },
    abort() { ctl.abort(); reviews.delete(runId) },
    async retry(step) {
      await previewBot(client, step, { timeoutMs: opts.timeoutMs, signal: ctl.signal, onUpdate: () => update(summarize(run.summary.steps)) })
    },
  }
  const update = s => { run.summary = s; listeners.forEach(fn => fn(run)) }
  run.done = prepare(client, plan, { ...opts, signal: ctl.signal, onUpdate: update })
    .then(update, e => { run.error = e; listeners.forEach(fn => fn(run)) })
  reviews.set(runId, run)
  return run
}

export function forgetReview(runId) {
  const run = reviews.get(runId)
  if (run) run.abort()
}

/**
 * Re-read what the host now holds and mark each applied step "verified" only when the
 * change is really there: the policy reads back with the proposed pairs and limits, the
 * ticks include every Bot, and each Bot's spec (read by GET /setup on the gateway) has
 * the stable command and every a2a tool. Anything else is "not done", with why.
 * Returns { ok, results: [{ state: 'verified' | 'not_done', why }] } in step order.
 */
export async function verify(client, steps, done) {
  const results = steps.map(() => ({ state: 'not_done', why: 'not applied' }))
  let setup = null, policy = null, grants = null, readError = null
  try {
    ;[setup, policy, grants] = await Promise.all([
      client.get('/api/apps/a2a/setup'), client.get('/api/apps/a2a/policy'), client.botGrants()])
  } catch (e) { readError = e }
  steps.forEach((s, i) => {
    const r = results[i]
    if (done[i] !== 'done') {
      r.why = s.error ? (s.error.permission ? 'waiting for a permission approval' : s.error.message)
        : s.state && s.state !== 'ready' ? `the preview ${s.state === 'timeout' ? 'timed out' : 'failed'}` : 'not applied'
      return
    }
    if (readError) { r.why = `could not read it back: ${readError.message}`; return }
    if (s.kind === 'policy') {
      const want = s.body
      const allowOk = Object.entries(want.allow || {}).every(([a, ts]) => ts.every(t => ((policy.allow || {})[a] || []).includes(t)))
      const orchOk = !want.orchestrate || (policy.orchestrate || {}).max_bots === want.orchestrate.max_bots
      Object.assign(r, allowOk && orchOk ? { state: 'verified', why: '' } : { why: 'the saved policy does not show the change' })
    } else if (s.kind === 'grants') {
      const have = new Set((grants && grants.bots) || [])
      const missing = s.body.filter(b => !have.has(b))
      Object.assign(r, missing.length ? { why: `still not ticked: ${missing.join(', ')}` } : { state: 'verified', why: '' })
    } else {
      const row = (setup.bots || []).find(b => b.id === s.bot.id)
      const h = row && row.health
      Object.assign(r, h && h.ok ? { state: 'verified', why: '' }
        : { why: h ? `the Bot's settings still show: ${h.problems.join('; ')}` : "could not read the Bot's settings back" })
    }
  })
  return { ok: steps.length > 0 && results.every(r => r.state === 'verified'), results }
}

/** Apply the confirmed steps in order. *report(i, state, error)* is called per step. */
export async function commit(client, steps, report) {
  let failed = 0
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s.error || (s.state && s.state !== 'ready')) { report(i, 'skipped', s.error); continue }
    report(i, 'running')
    try {
      if (s.kind === 'policy') await client.put('/api/apps/a2a/policy', s.body)
      else if (s.kind === 'grants') await client.setBotGrants(s.body)
      else await client.commitCapabilities(s.bot.agent, s.body)
      report(i, 'done')
    } catch (e) {
      failed++
      report(i, 'failed', e)
    }
  }
  return failed
}
