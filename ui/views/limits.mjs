// Limits as steppers: a number you can type, with − and + beside it and its range in words.

import { useId } from 'react'
import { Button, h } from '../lib/ui.mjs'

function Stepper({ label, help, value, min, max, step = 1, unit, onChange, extra }) {
  const id = useId()
  const clamp = v => Math.min(max, Math.max(min, Math.round(Number(v) || min)))
  return h('div', { className: 'a2a-limit' },
    h('label', { htmlFor: id }, label),
    h('div', { className: 'a2a-stepper' },
      h(Button, { kind: 'quiet', icon: 'Minus', 'aria-label': `Less: ${label}`, disabled: value <= min,
        onClick: () => onChange(clamp(value - step)) }),
      // Scrolling the page over a focused number field changes it in some browsers;
      // a limit only moves when the owner types or presses - or +.
      h('input', { id, type: 'number', inputMode: 'numeric', min, max, step, value,
        onWheel: e => e.currentTarget.blur(),
        'aria-describedby': `${id}-help`, onChange: e => onChange(clamp(e.target.value)) }),
      h(Button, { kind: 'quiet', icon: 'Plus', 'aria-label': `More: ${label}`, disabled: value >= max,
        onClick: () => onChange(clamp(value + step)) }),
      unit ? h('span', { className: 'a2a-faint' }, unit) : null,
      extra || null),
    h('p', { id: `${id}-help`, className: 'a2a-faint' }, help))
}

export default function Limits({ policy, onChange, allBots }) {
  const orch = policy.orchestrate || {}
  const rate = policy.rate_limit || { sends: 30, window_secs: 600 }
  return h('div', { className: 'a2a-limits' },
    h(Stepper, { label: 'Turns per conversation', min: 1, max: 10, value: policy.max_turns_per_context,
      help: 'Questions and answers on one conversation before a2a refuses the next. Default 5, up to 10.',
      onChange: v => onChange({ ...policy, max_turns_per_context: v }) }),
    h(Stepper, { label: 'Bots per orchestration', min: 1, max: 16, value: orch.max_bots,
      help: 'How many Bots one question may go to at once. 1 to 16. A run that asks for more is refused, never trimmed.',
      onChange: v => onChange({ ...policy, orchestrate: { ...orch, max_bots: v } }),
      extra: allBots > 1 && orch.max_bots !== allBots ? h(Button, { kind: 'quiet', onClick: () =>
        onChange({ ...policy, orchestrate: { ...orch, max_bots: allBots } }) }, `All my Bots (${allBots})`) : null }),
    h(Stepper, { label: 'Orchestration time budget', min: 10, max: 600, step: 10, unit: 'seconds', value: orch.time_budget_secs,
      help: 'Answers that arrive later are dropped. 10 to 600 seconds.',
      onChange: v => onChange({ ...policy, orchestrate: { ...orch, time_budget_secs: v } }) }),
    h(Stepper, { label: 'Sends per Bot', min: 1, max: 300, value: rate.sends,
      help: 'How many questions one Bot may send in the window below before a2a refuses more. Default 30, up to 300.',
      onChange: v => onChange({ ...policy, rate_limit: { ...rate, sends: v } }) }),
    h(Stepper, { label: 'Send-limit window', min: 60, max: 3600, step: 60, unit: 'seconds', value: rate.window_secs,
      help: 'The window the send limit counts over. Default 600 (10 minutes), 60 to 3600.',
      onChange: v => onChange({ ...policy, rate_limit: { ...rate, window_secs: v } }) }),
    h('div', { className: 'a2a-limit' },
      h('label', { className: 'a2a-offer' },
        h('input', { type: 'checkbox', checked: policy.auto_update_tools !== false,
          onChange: e => onChange({ ...policy, auto_update_tools: e.target.checked }) }),
        h('span', { className: 'a2a-label' }, "Keep my Bots' A2A tools up to date")),
      h('p', { className: 'a2a-faint' }, 'When you open this page, Bots that already have A2A get the tools a newer version adds. Only A2A tools change, and you can undo it.')),
    h('div', { className: 'a2a-limit' },
      h('span', { className: 'a2a-label' }, 'Scope'),
      h('p', { className: 'a2a-scope' }, policy.scope === 'answer_only' ? 'Answer only' : policy.scope),
      h('p', { className: 'a2a-faint' }, 'A Bot that is asked replies and changes nothing. This build has no other scope.')))
}
