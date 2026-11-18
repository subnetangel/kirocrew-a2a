// The page's only HTTP client: the host SDK's useAppApi(). It carries the signed-in
// owner's own dashboard session and the manifest's permissions.api scope. The page never
// uses the browser's raw fetch API and never handles a token, so an owner-only host route (capabilities,
// bot-grants) is only ever reached by the owner, from this page, after a confirmation.

import { useCallback, useMemo, useRef } from 'react'

const MODS = (typeof window !== 'undefined' && window.__kirocrew_modules) || {}
export const SDK = MODS['@kirocrew/app-sdk'] || {}
export const LUCIDE = MODS['lucide-react'] || {}
export const API = '/api/apps/a2a'

/** An HTTP failure with the real status, for the page's error states. */
export class HttpError extends Error {
  constructor(status, body, path) {
    const detail = shortBody(body)
    super(status ? `HTTP ${status}${detail ? `: ${detail}` : ''}` : String(body || 'request failed'))
    this.status = status || 0
    this.body = body
    this.path = path
  }
}

function shortBody(body) {
  if (!body) return ''
  let text = typeof body === 'string' ? body : JSON.stringify(body)
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') text = parsed.error || parsed.code || parsed.message || text
  } catch { /* plain text */ }
  return String(text).slice(0, 200)
}

/** Canonical unpadded base64url of a crew name, the host's proxy-safe route segment. */
export function b64name(name) {
  const bytes = new TextEncoder().encode(name)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function useClient() {
  let api = null
  try { api = typeof SDK.useAppApi === 'function' ? SDK.useAppApi() : null } catch { api = null }
  // Held in a ref so the client stays one object across renders: effects and pollers
  // keyed on it must not restart just because the host handed back a new wrapper.
  const ref = useRef(api)
  ref.current = api
  const call = useCallback(async (path, init = {}) => {
    const api = ref.current
    if (!api || typeof api.request !== 'function') throw new HttpError(0, 'the dashboard did not provide its app client (useAppApi)', path)
    const opts = { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } }
    try {
      return await api.request(path, opts)
    } catch (e) {
      if (e && e.name === 'AppApiPermissionError') {
        // The host refuses before sending: this path is in the manifest but its permission
        // is still waiting for the owner's approval on the app page (or the page predates it).
        const err = new HttpError(403, 'A2A is waiting for you to approve a new permission. Open the A2A app page, approve the pending permission, then reload this page', path)
        err.permission = true
        throw err
      }
      throw new HttpError(e && e.status, (e && e.body) || (e && e.message) || String(e), path)
    }
  }, [])
  return useMemo(() => ({
    call,
    get: path => call(path),
    put: (path, body) => call(path, { method: 'PUT', body: JSON.stringify(body) }),
    post: (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) }),
    // The host's own owner routes. Same calls the dashboard's capability cards make.
    capabilities: (agent, init = {}) => call(`/api/agents/b64/${b64name(agent)}/capabilities`, init),
    previewCapabilities: (agent, body, init = {}) => call(`/api/agents/b64/${b64name(agent)}/capabilities/preview`,
      { ...init, method: 'POST', body: JSON.stringify(body) }),
    commitCapabilities: (agent, body) => call(`/api/agents/b64/${b64name(agent)}/capabilities`,
      { method: 'PUT', body: JSON.stringify(body) }),
    botGrants: () => call(`${API}/bot-grants`),
    setBotGrants: bots => call(`${API}/bot-grants`, { method: 'PUT', body: JSON.stringify({ bots }) }),
  }), [call])
}

export function useNav() {
  let nav = null
  try { nav = typeof SDK.useNavigate === 'function' ? SDK.useNavigate() : null } catch { nav = null }
  return nav
}
