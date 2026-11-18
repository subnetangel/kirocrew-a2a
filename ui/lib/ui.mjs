// Small shared pieces: the stylesheet, icons, buttons, status pills, error and loading states.

import { createElement as h, useEffect, useState } from 'react'
import { LUCIDE, useNav } from './api.mjs'

export { h }

const CSS_URL = new URL('../a2a.css', import.meta.url).href

/** Load the page's stylesheet once; replace it after an update so old rules never linger. */
export function useStyles(version) {
  useEffect(() => {
    const href = `${CSS_URL}?v=${encodeURIComponent(version || '')}`
    let el = document.getElementById('a2a-css')
    if (!el) {
      el = document.createElement('link')
      el.id = 'a2a-css'
      el.rel = 'stylesheet'
      document.head.appendChild(el)
    }
    if (el.getAttribute('href') !== href) el.setAttribute('href', href)
  }, [version])
}

export function Icon({ name, size = 16, className }) {
  const C = LUCIDE[name]
  if (!C) return h('span', { className: `a2a-icon ${className || ''}`, style: { width: size, height: size }, 'aria-hidden': true })
  return h(C, { size, strokeWidth: 1.75, className: `a2a-icon ${className || ''}`, 'aria-hidden': true, focusable: 'false' })
}

export function Button({ kind = 'default', icon, children, className, busy, ...rest }) {
  return h('button', {
    type: 'button', className: `a2a-btn a2a-btn-${kind} ${className || ''}`, 'aria-busy': busy || undefined, ...rest,
  }, busy ? h(Icon, { name: 'LoaderCircle', className: 'a2a-spin' }) : icon ? h(Icon, { name: icon }) : null,
  children && h('span', null, children))
}

const PILL = {
  answered: ['Check', 'Answered'], refused: ['Ban', 'Refused'], failed: ['TriangleAlert', 'Failed'],
  working: ['Clock', 'In progress'], info: ['Info', 'Note'], ok: ['Check', 'OK'], bad: ['X', 'Needs repair'],
}

/** A status word with an icon, so state never rides on colour alone. */
export function Pill({ tone, children }) {
  const [icon, word] = PILL[tone] || PILL.info
  return h('span', { className: `a2a-pill a2a-pill-${tone}` }, h(Icon, { name: icon, size: 13 }), children || word)
}

export function ErrorBox({ title, error, onRetry }) {
  const navigate = useNav()
  // A path this version is not yet approved for: the fix is the app page's own approval
  // (or its Update button), never a command.
  const approve = error && error.permission && navigate
  return h('div', { className: 'a2a-error', role: 'alert' },
    h(Icon, { name: 'CircleAlert', size: 18 }),
    h('div', null,
      h('strong', null, title),
      h('p', null, error ? error.message || String(error) : 'Unknown error'),
      error && error.path ? h('p', { className: 'a2a-faint a2a-mono' }, error.path) : null),
    approve ? h(Button, { icon: 'ArrowRight', onClick: () => navigate('/apps/detail/a2a') }, 'Open the A2A app page')
      : onRetry ? h(Button, { icon: 'RotateCw', onClick: onRetry }, 'Retry') : null)
}

export function Skeleton({ rows = 3, label }) {
  return h('div', { className: 'a2a-skeleton', role: 'status', 'aria-label': label || 'Loading' },
    Array.from({ length: rows }, (_, i) => h('span', { key: i, style: { width: `${92 - i * 11}%` } })))
}

export function Empty({ icon = 'Inbox', title, children }) {
  return h('div', { className: 'a2a-empty' }, h(Icon, { name: icon, size: 22 }),
    h('strong', null, title), children ? h('p', null, children) : null)
}

export function Section({ id, title, aside, children, className }) {
  return h('section', { className: `a2a-section ${className || ''}`, 'aria-labelledby': `${id}-h` },
    h('header', { className: 'a2a-section-head' },
      h('h2', { id: `${id}-h` }, title), aside ? h('div', { className: 'a2a-section-aside' }, aside) : null),
    children)
}

/** A value persisted in localStorage under an a2a-prefixed key. */
export function usePersisted(key, initial) {
  const full = `a2a.${key}`
  const [value, setValue] = useState(() => {
    try { const v = localStorage.getItem(full); return v === null ? initial : JSON.parse(v) } catch { return initial }
  })
  useEffect(() => { try { localStorage.setItem(full, JSON.stringify(value)) } catch { /* private mode */ } }, [full, value])
  return [value, setValue]
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`
}
