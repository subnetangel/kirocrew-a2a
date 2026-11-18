// node --test tests/ui.test.mjs : the page's pure logic (feed grouping, setup apply order).
import assert from 'node:assert/strict'
import test from 'node:test'
import { filterItems, groupRows, reasonText } from '../ui/lib/feed.mjs'
import { commit, forgetReview, prepare, reviewFor, verify, with503Retry } from '../ui/lib/apply.mjs'
import { autoHeal, undoHeal } from '../ui/lib/heal.mjs'
import { OPEN, STATUS_TONE, STATUS_WORD, ageText, effectiveMode, modeOptions, needsYoloConfirm, parseTerms } from '../ui/lib/cos.mjs'

const rows = [
  { ts: '2026-11-18T00:00:01Z', op: 'send', outcome: 'delivering', caller: 'assistant', target: 'researcher', context: 'c1', turn: 1 },
  { ts: '2026-11-18T00:00:09Z', op: 'send', outcome: 'completed', caller: 'assistant', target: 'researcher', context: 'c1' },
  { ts: '2026-11-18T00:01:00Z', op: 'send', outcome: 'denied', caller: 'writer', target: 'researcher', reason: 'policy' },
  { ts: '2026-11-18T00:02:00Z', op: 'orchestrate', outcome: 'started', caller: 'assistant', run: 'r1', targets: 'researcher,writer' },
  { ts: '2026-11-18T00:02:01Z', op: 'send', outcome: 'delivering', caller: 'assistant', target: 'researcher', context: 'c2', run: 'r1' },
  { ts: '2026-11-18T00:02:01Z', op: 'send', outcome: 'delivering', caller: 'assistant', target: 'writer', context: 'c3', run: 'r1' },
  { ts: '2026-11-18T00:02:20Z', op: 'send', outcome: 'completed', caller: 'assistant', target: 'researcher', context: 'c2' },
  { ts: '2026-11-18T00:02:30Z', op: 'send', outcome: 'timeout', caller: 'assistant', target: 'writer', context: 'c3' },
  { ts: '2026-11-18T00:02:31Z', op: 'orchestrate', outcome: 'completed', caller: 'assistant', run: 'r1' },
  { ts: '2026-11-18T00:03:00Z', op: 'send', outcome: 'rejected', caller: 'assistant', target: 'researcher', context: 'c1', reason: 'loop_cap 3/3' },
  { ts: '2026-11-18T00:04:00Z', op: 'policy', outcome: 'updated', by: 'owner' },
]

test('rows group into conversations, runs and events, newest first', () => {
  const items = groupRows(rows)
  assert.deepEqual(items.map(i => i.key), ['row:10', 'ctx:c1', 'run:r1', 'row:2'])
  const run = items.find(i => i.kind === 'run')
  assert.deepEqual(run.contexts, ['c2', 'c3'])
  assert.deepEqual(run.targets, ['researcher', 'writer'])
  assert.equal(run.cls, 'answered')
  const c1 = items.find(i => i.key === 'ctx:c1')
  assert.equal(c1.cls, 'refused')
  assert.equal(c1.reason, 'Reached the limit of 3 turns for one conversation')
  assert.equal(items.find(i => i.key === 'row:2').reason, 'Not allowed by your who-may-ask-whom settings')
})

test('filters by Bot, outcome and op', () => {
  const items = groupRows(rows)
  assert.deepEqual(filterItems(items, { outcome: 'refused' }).map(i => i.key), ['ctx:c1', 'row:2'])
  assert.deepEqual(filterItems(items, { bot: 'writer' }).map(i => i.key), ['run:r1', 'row:2'])
  assert.deepEqual(filterItems(items, { op: 'policy' }).map(i => i.key), ['row:10'])
  assert.deepEqual(filterItems(items, { op: 'orchestrate' }).map(i => i.key), ['run:r1'])
})

test('reason words', () => {
  assert.match(reasonText({ reason: 'too_many 9/8' }), /9 Bots; the limit is 8/)
  assert.match(reasonText({ outcome: 'error', error: 'boom' }), /boom/)
})

function fakeClient(log, { failPreview = '' } = {}) {
  return {
    capabilities: async agent => { log.push(['GET', agent]); return { revision: `rev-${agent}` } },
    previewCapabilities: async (agent, body) => {
      log.push(['PREVIEW', agent, body])
      if (agent === failPreview) throw Object.assign(new Error('HTTP 409: stale_revision'), { status: 409 })
      return { preview_token: `tok-${agent}`, impact: [{ section: 'mcpServers', id: 'a2a:a2a', change: 'added' }] }
    },
    commitCapabilities: async (agent, body) => { log.push(['PUT', agent, body]) },
    put: async (path, body) => { log.push(['PUT', path, body]) },
    setBotGrants: async bots => { log.push(['GRANTS', bots]) },
  }
}

const setup = {
  policy: { complete: false, missing_pairs: [['a', 'b']], proposed_allow: { a: ['b'], b: ['a'] } },
  bots: [
    { id: 'a', name: 'A', agent: 'A', ops: [{ section: 'mcpServers', id: 'a2a:a2a', action: 'set', value: { command: '/usr/bin/python3', args: ['/x/mcp_server.py'] } }] },
    { id: 'b', name: 'B', agent: 'B', ops: [] },
    { id: 'c', name: 'C', agent: 'C', ops: [{ section: 'tools', id: '@a2a:a2a', action: 'set', value: true }] },
  ],
}

test('setup previews first, writes nothing, then commits in order with the preview token', async () => {
  const log = []
  const client = fakeClient(log)
  const plan = await prepare(client, { setup, policy: { max_turns_per_context: 3, allow: { a: [] } }, grants: ['a'],
    want: { policy: true, grants: true, bots: ['a', 'b', 'c'] } })
  assert.ok(log.every(([verb]) => verb === 'GET' || verb === 'PREVIEW'), 'prepare only reads and previews')
  assert.deepEqual(plan.steps.map(s => s.kind), ['policy', 'grants', 'bot', 'bot'])  // b has no ops
  assert.deepEqual(plan.steps[1].body, ['a', 'b', 'c'])
  log.length = 0
  const failed = await commit(client, plan.steps, () => {})
  assert.equal(failed, 0)
  assert.deepEqual(log.map(l => l.slice(0, 2)), [['PUT', '/api/apps/a2a/policy'], ['GRANTS', ['a', 'b', 'c']], ['PUT', 'A'], ['PUT', 'C']])
  assert.equal(log[2][2].preview_token, 'tok-A')
  assert.equal(log[2][2].revision, 'rev-A')
  assert.deepEqual(log[0][2].allow, { a: ['b'], b: ['a'] })
  assert.equal(log[0][2].max_turns_per_context, 3)
})

test('a refused preview skips that Bot and never commits it', async () => {
  const log = []
  const client = fakeClient(log, { failPreview: 'A' })
  const plan = await prepare(client, { setup, policy: {}, grants: ['a', 'b', 'c'], want: { policy: false, grants: true, bots: ['a', 'c'] } })
  assert.deepEqual(plan.steps.map(s => s.kind), ['bot', 'bot'])  // grants already complete
  assert.equal(plan.steps[0].error.status, 409)
  log.length = 0
  const states = []
  await commit(client, plan.steps, (i, s) => states.push([i, s]))
  assert.deepEqual(log.map(l => l.slice(0, 2)), [['PUT', 'C']])
  assert.deepEqual(states[0], [0, 'skipped'])
})

test('setup can raise Bots per orchestration to all my Bots, and never lowers it', async () => {
  const log = []
  const client = fakeClient(log)
  const done = { ...setup, policy: { ...setup.policy, complete: true, missing_pairs: [] } }
  const policy = { allow: { a: ['b'] }, orchestrate: { max_bots: 4, time_budget_secs: 300 } }
  let plan = await prepare(client, { setup: done, policy, grants: ['a', 'b', 'c'], want: { policy: true, orchAll: 9 } })
  assert.equal(plan.steps.length, 1)
  assert.deepEqual(plan.steps[0].body.orchestrate, { max_bots: 9, time_budget_secs: 300 })
  assert.deepEqual(plan.steps[0].body.allow, { a: ['b'] })  // pairs untouched when already complete
  plan = await prepare(client, { setup: done, policy: { ...policy, orchestrate: { max_bots: 12 } }, grants: ['a', 'b', 'c'],
    want: { policy: true, orchAll: 9 } })
  assert.equal(plan.steps.length, 0)
})

test('a permission still waiting for approval blocks the whole setup', async () => {
  const log = []
  const client = fakeClient(log)
  client.capabilities = async () => {
    throw Object.assign(new Error('HTTP 403: A2A is waiting for you to approve a new permission'), { status: 403, permission: true })
  }
  const plan = await prepare(client, { setup, policy: {}, grants: [], want: { policy: true, grants: true, bots: ['a', 'c'] } })
  assert.ok(plan.needsApproval && plan.needsApproval.permission)
  assert.match(plan.needsApproval.message, /approve a new permission/)
})


const sixBots = {
  policy: { complete: true, missing_pairs: [], proposed_allow: {} },
  bots: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map(id => ({ id, name: id.toUpperCase(), agent: id,
    ops: [{ section: 'tools', id: '@a2a:a2a', action: 'set', value: true }] })),
}
const sixPlan = { setup: sixBots, policy: {}, grants: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
  want: { policy: false, grants: false, bots: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] } }

function slowClient({ delay = 20, hang = '' } = {}) {
  const stats = { gets: 0, previews: 0, live: 0, maxLive: 0 }
  return {
    stats,
    capabilities: async (agent, init) => {
      stats.gets++; stats.live++; stats.maxLive = Math.max(stats.maxLive, stats.live)
      try {
        if (agent === hang) await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
        await new Promise(r => setTimeout(r, delay))
        return { revision: `rev-${agent}` }
      } finally { stats.live-- }
    },
    previewCapabilities: async agent => { stats.previews++; return { preview_token: `tok-${agent}`, impact: [{ section: 'tools', id: '@a2a:a2a', change: 'added' }] } },
  }
}

test('a re-render, poll or remount during review never starts a second review', async () => {
  const client = slowClient()
  const first = reviewFor('run-1', client, sixPlan)
  // What a 10 s poll or a host re-render does: the dialog renders again with a new plan object.
  for (let i = 0; i < 5; i++) assert.equal(reviewFor('run-1', client, { ...sixPlan }), first)
  await first.done
  assert.equal(client.stats.gets, 6)
  assert.equal(client.stats.previews, 6)
  assert.ok(first.summary.settled && first.summary.checked === 6)
  forgetReview('run-1')
  const second = reviewFor('run-2', client, sixPlan)  // a new button press is a new review
  assert.notEqual(second, first)
  await second.done
  assert.equal(client.stats.previews, 12)
  forgetReview('run-2')
})

test('previews run one at a time, and a hung Bot times out on its own line', async () => {
  const client = slowClient({ delay: 15, hang: 'b2' })
  const updates = []
  const t0 = Date.now()
  const out = await prepare(client, sixPlan, { timeoutMs: 120, onUpdate: s => updates.push(s.checked) })
  assert.equal(client.stats.maxLive, 1, `max in flight ${client.stats.maxLive}`)
  const states = Object.fromEntries(out.steps.map(s => [s.bot.id, s.state]))
  assert.equal(states.b2, 'timeout')
  assert.deepEqual(Object.values(states).filter(x => x === 'ready').length, 5)
  assert.ok(out.settled && out.checked === 6)
  assert.ok(Date.now() - t0 < 1000, 'the hung Bot did not hold the others')
  assert.ok(updates.length > 6, 'progress was reported as Bots finished')
  assert.ok(out.steps.find(s => s.bot.id === 'b2').error.message.includes('No answer'))
})

test('Retry previews only the failed Bot again', async () => {
  const client = slowClient({ delay: 5, hang: 'b3' })
  const run = reviewFor('run-3', client, sixPlan, { timeoutMs: 60 })
  await run.done
  const step = run.summary.steps.find(s => s.bot.id === 'b3')
  assert.equal(step.state, 'timeout')
  client.capabilities = async () => ({ revision: 'rev-b3' })
  const before = client.stats.previews
  await run.retry(step)
  assert.equal(step.state, 'ready')
  assert.equal(client.stats.previews, before + 1)
  assert.ok(run.summary.settled)
  forgetReview('run-3')
})


function hostClient({ blockAgents = [], healthyAfter = true } = {}) {
  const host = { policy: { allow: {}, orchestrate: { max_bots: 4 } }, grants: [], healthy: new Set(), puts: [] }
  const client = {
    host,
    capabilities: async agent => {
      if (blockAgents.includes(agent)) throw Object.assign(new Error('HTTP 403: A2A is waiting for you to approve a new permission'), { status: 403, permission: true })
      return { revision: `rev-${agent}` }
    },
    previewCapabilities: async agent => ({ preview_token: `tok-${agent}`, impact: [{ section: 'tools', id: '@a2a:a2a', change: 'added' }] }),
    commitCapabilities: async agent => { host.puts.push(agent); if (healthyAfter) host.healthy.add(agent) },
    put: async (path, body) => { host.policy = body },
    setBotGrants: async bots => { host.grants = bots },
    botGrants: async () => ({ bots: host.grants }),
    get: async path => path.endsWith('/policy') ? host.policy : {
      bots: sixBots.bots.map(b => ({ id: b.id, health: { ok: host.healthy.has(b.id), problems: host.healthy.has(b.id) ? [] : ['not allowed: a2a_orchestrate'] } })) },
  }
  return client
}

async function applyAll(client, plan) {
  const out = await prepare(client, plan, { timeoutMs: 200 })
  const done = {}
  await commit(client, out.steps, (i, st) => { done[i] = st })
  return { out, checked: await verify(client, out.steps, done) }
}

test('blocked Bot steps never produce a success state', async () => {
  const client = hostClient({ blockAgents: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] })
  const { out, checked } = await applyAll(client, sixPlan)
  assert.ok(out.needsApproval)
  assert.equal(client.host.puts.length, 0)
  assert.equal(checked.ok, false)
  assert.ok(checked.results.every(r => r.state === 'not_done'))
  assert.match(checked.results[0].why, /permission approval/)
})

test('a commit that does not show up in the Bot settings is not done', async () => {
  const client = hostClient({ healthyAfter: false })
  const { checked } = await applyAll(client, sixPlan)
  assert.equal(client.host.puts.length, 6)  // the calls "succeeded"
  assert.equal(checked.ok, false)
  assert.ok(checked.results.every(r => r.state === 'not_done' && /still show/.test(r.why)))
})

test('success only when every step reads back', async () => {
  const client = hostClient()
  const plan = { ...sixPlan, policy: { allow: {}, orchestrate: { max_bots: 4 } }, grants: [],
    setup: { ...sixBots, policy: { complete: false, missing_pairs: [['b1', 'b2']], proposed_allow: { b1: ['b2'] } } },
    want: { ...sixPlan.want, policy: true, grants: true, orchAll: 5 } }
  const { checked } = await applyAll(client, plan)
  assert.equal(checked.ok, true, JSON.stringify(checked.results))
  assert.equal(checked.results.length, 8)
  const partial = hostClient({ blockAgents: ['b4'] })
  const r2 = await applyAll(partial, sixPlan)
  assert.equal(r2.checked.ok, false)  // one Bot not done is never "finished"
})


test('saving the grid keeps pairs for Bots it does not show', async () => {
  const { setAll, setCol, setPair, setRow } = await import('../ui/lib/matrix.mjs')
  const allow = { a: ['b', 'hidden'], hidden: ['a', 'b'], owner: ['a'] }
  const shown = ['a', 'b']
  for (const next of [setAll(allow, shown, false), setAll(allow, shown, true), setRow(allow, shown, 'a', false),
    setCol(allow, shown, 'b', false), setPair(allow, 'a', 'b', false)]) {
    assert.ok(next.a.includes('hidden'), 'a -> hidden kept')
    assert.deepEqual(next.hidden, ['a', 'b'])
    assert.deepEqual(next.owner, ['a'])
  }
  assert.deepEqual(setAll(allow, shown, false).a, ['hidden'])
})

test('a send with no outcome long ago is failed, never in progress', () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const fresh = new Date().toISOString()
  const items = groupRows([
    { ts: old, op: 'send', outcome: 'delivering', caller: 'a', target: 'b', context: 's1' },
    { ts: fresh, op: 'send', outcome: 'delivering', caller: 'a', target: 'b', context: 's2' }])
  const by = Object.fromEntries(items.map(i => [i.key, i]))
  assert.equal(by['ctx:s1'].cls, 'failed')
  assert.match(by['ctx:s1'].reason, /No outcome/)
  assert.equal(by['ctx:s2'].cls, 'working')
})

test('setup reaches complete with roster Bots that have no chat yet', async () => {
  const { setupState } = await import('../ui/lib/setupState.mjs')
  const bots = [
    { id: 'a', name: 'A', owned: true, chat: true, health: { ok: true } },
    { id: 'b', name: 'B', owned: true, chat: false, health: { ok: true } },     // no chat yet
    { id: 'c', name: 'C', owned: false, chat: false, health: null },            // shared template
  ]
  const setup = { bots, policy: { complete: true, missing_pairs: [] }, mounts_complete: true }
  const st = setupState(setup, ['a', 'b', 'c', 'kirocrew-worker'], 2)
  assert.equal(st.complete, true, JSON.stringify(st.checks))
  assert.equal(st.allBots, 2)
  assert.deepEqual(st.strayTicks, ['kirocrew-worker'])  // a stray tick is shown, never blocks
  assert.equal(setupState(setup, ['a', 'b'], 2).complete, false)  // c not ticked
  assert.equal(setupState(setup, ['a', 'b', 'c'], 1).complete, false)  // limit below all Bots
})

test('policy pairs for agents off the roster stay until removed', async () => {
  const { removeAgent, setAll } = await import('../ui/lib/matrix.mjs')
  const allow = { a: ['b', 'kirocrew-worker'], b: ['a'], 'kirocrew-worker': ['a'], owner: ['a', 'kirocrew-worker'] }
  const edited = setAll(allow, ['a', 'b'], false)
  assert.ok(edited.a.includes('kirocrew-worker') && edited['kirocrew-worker'])  // grid edits keep them
  const removed = removeAgent(allow, 'kirocrew-worker')
  assert.deepEqual(removed, { a: ['b'], b: ['a'], owner: ['a'] })
})

test('identical consecutive failures fold into one row; answers never fold', async () => {
  const { collapseRepeats } = await import('../ui/lib/feed.mjs')
  const mk = (i, cls, reason = 'No outcome was recorded') => ({ key: `k${i}`, kind: 'conversation', cls, caller: 'r', targets: ['f'], reason, last: `2026-11-18T01:${10 + i}:00Z` })
  const out = collapseRepeats([mk(9, 'answered', ''), mk(8, 'failed'), mk(7, 'failed'), mk(6, 'failed'), mk(5, 'refused', 'x'), mk(4, 'failed')])
  assert.deepEqual(out.map(i => [i.key, i.repeats ? i.repeats.length : 1]), [['k9', 1], ['k8', 3], ['k5', 1], ['k4', 1]])
})

test('the activity view defaults to the last 24 hours', async () => {
  const { filterItems } = await import('../ui/lib/feed.mjs')
  const now = Date.parse('2026-11-18T12:00:00Z')
  const items = [{ last: '2026-11-18T11:00:00Z', caller: 'a', targets: [] }, { last: '2026-11-16T11:00:00Z', caller: 'a', targets: [] }]
  assert.equal(filterItems(items, {}, now).length, 1)
  assert.equal(filterItems(items, { since: 'all' }, now).length, 2)
})


test('a 503 is retried twice, then gives up', async () => {
  let n = 0
  const flaky = async () => { n++; if (n < 3) throw Object.assign(new Error('HTTP 503'), { status: 503 }); return 'ok' }
  assert.equal(await with503Retry(flaky, { delayMs: 1 }), 'ok')
  n = -10
  await assert.rejects(with503Retry(flaky, { delayMs: 1 }), /503/)
  let m = 0
  await assert.rejects(with503Retry(async () => { m++; throw Object.assign(new Error('HTTP 409'), { status: 409 }) }, { delayMs: 1 }))
  assert.equal(m, 1, 'only a 503 is retried')
})

function healClient(fail = []) {
  const calls = []
  return { calls,
    capabilities: async a => { calls.push(['GET', a]); if (fail.includes(a)) throw Object.assign(new Error('HTTP 503'), { status: 503 }); return { revision: `r-${a}` } },
    previewCapabilities: async (a, body) => { calls.push(['PREVIEW', a, body.operations]); return { preview_token: `t-${a}` } },
    commitCapabilities: async (a, body) => { calls.push(['PUT', a, body.operations, body.preview_token]) } }
}
const healOps = [{ section: 'allowedTools', id: '@a2a:a2a/a2a_cancel', action: 'set', value: true },
  { section: 'allowedTools', id: '@a2a:a2a', action: 'set', value: true }]
const healSetup = { bots: [
  { id: 'a', agent: 'A', health: { ok: true }, heal: healOps },
  { id: 'b', agent: 'B', health: { ok: true }, heal: [] },
  { id: 'c', agent: 'C', health: { ok: false }, heal: healOps },  // a fault is Repair's job
  { id: 'd', agent: 'D', health: { ok: true }, heal: [{ section: 'mcpServers', id: 'a2a:a2a', action: 'set', value: {} }] },
  { id: 'e', agent: 'E', health: { ok: true }, heal: healOps } ] }

test('auto-heal only adds a2a tools, only to healthy mounts, one Bot at a time', async () => {
  const client = healClient(['E'])
  const r = await autoHeal(client, healSetup, { auto_update_tools: true }, { retryDelayMs: 1 })
  assert.deepEqual(r.healed.map(h => h.id), ['a'])
  assert.deepEqual(r.failed, ['e'])  // stays amber; tried again next load
  const puts = client.calls.filter(c => c[0] === 'PUT')
  assert.equal(puts.length, 1)
  assert.ok(puts[0][2].every(o => o.section === 'allowedTools' && o.id.startsWith('@a2a:a2a')))
  assert.equal(client.calls.filter(c => c[1] === 'E' && c[0] === 'GET').length, 3)  // two 503 retries
  assert.ok(!client.calls.some(c => ['B', 'C', 'D'].includes(c[1])))
})

test('auto-heal is off when the owner turns it off, and Undo removes exactly what it added', async () => {
  const off = healClient()
  assert.deepEqual(await autoHeal(off, healSetup, { auto_update_tools: false }), { healed: [], failed: [] })
  assert.equal(off.calls.length, 0)
  const client = healClient()
  const r = await autoHeal(client, { bots: [healSetup.bots[0]] }, {}, { retryDelayMs: 1 })
  client.calls.length = 0
  assert.deepEqual(await undoHeal(client, r.healed, { retryDelayMs: 1 }), [])
  const put = client.calls.find(c => c[0] === 'PUT')
  assert.deepEqual(put[2], healOps.map(o => ({ section: 'allowedTools', id: o.id, action: 'remove' })))
})

test('approval modes the ceiling denies are disabled, and fall back to Approve', () => {
  const ceiling = { normal: true, trust_reads: true, trust: false, yolo: false }
  assert.deepEqual(modeOptions(ceiling).map(o => [o.label, o.disabled]),
    [['Approve', false], ['Trust reads', false], ['Trust', true], ['YOLO', true]])
  assert.deepEqual(modeOptions(null).filter(o => !o.disabled).map(o => o.id), ['normal'])
  assert.equal(effectiveMode({ assign_mode_default: 'trust' }, 'a', ceiling), 'normal')
  assert.equal(effectiveMode({ assign_mode_default: 'trust', assign_mode_by_bot: { a: 'trust_reads' } }, 'a', ceiling), 'trust_reads')
})

test('turning YOLO on needs the confirm; keeping it on does not', () => {
  const off = { assign_mode_default: 'normal' }
  const on = { assign_mode_default: 'normal', assign_mode_by_bot: { a: 'yolo' } }
  assert.equal(needsYoloConfirm(off, on), true)
  assert.equal(needsYoloConfirm(off, { ...on, confirm_yolo: true }), false)
  assert.equal(needsYoloConfirm(on, on), false)
})

test('watch terms parse one per line or comma, de-duplicated', () => {
  assert.deepEqual(parseTerms('Atlas, atlas\n  Big   Rock \n\n'), ['Atlas', 'Big Rock'])
  assert.equal(ageText(30), 'just now')
  assert.equal(ageText(7200), '2 h')
})

test('a reply with no update and a timeout read as neither done nor open', () => {
  assert.equal(STATUS_WORD.replied, 'Replied, no update')
  assert.equal(STATUS_WORD.no_reply, 'No reply')
  assert.notEqual(STATUS_TONE.replied, STATUS_TONE.done)
  assert.ok(!OPEN.has('replied') && !OPEN.has('no_reply'))
})
