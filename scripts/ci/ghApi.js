// Minimal GitHub REST client for the pipeline scripts (Node built-ins only, no tokens in logs).
// `fetchImpl` is injectable so the logic can be unit tested without the network.

import { appendFileSync } from 'node:fs'

const API = 'https://api.github.com'

export class GhError extends Error {
  constructor(status, method, route) {
    super(`GitHub API ${method} ${route} failed with ${status}`);
    this.status = status;
  }
}

/**
 * @param {{ token: string, fetchImpl?: typeof fetch, base?: string }} options
 */
export function createApi({ token, fetchImpl = fetch, base = API }) {
  async function request(method, route, body) {
    const res = await fetchImpl(`${base}${route}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'burrow-pipeline',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new GhError(res.status, method, route.split('?')[0])
    if (res.status === 204) return null
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  /** GET every page of a list route. `pick` extracts the array from an object response. */
  async function paginate(route, { pick = (x) => x, maxPages = 30 } = {}) {
    const out = []
    const sep = route.includes('?') ? '&' : '?'
    for (let page = 1; page <= maxPages; page += 1) {
      const chunk = pick(await request('GET', `${route}${sep}per_page=100&page=${page}`))
      out.push(...chunk)
      if (chunk.length < 100) break
    }
    return out
  }

  return {
    get: (route) => request('GET', route),
    post: (route, body) => request('POST', route, body ?? {}),
    patch: (route, body) => request('PATCH', route, body),
    put: (route, body) => request('PUT', route, body),
    del: (route) => request('DELETE', route),
    paginate,
  }
}

/** Appends `key=value` lines to $GITHUB_OUTPUT (values are flattened to one line). */
export function writeOutputs(file, values) {
  if (!file) return
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, ' ')}`)
  appendFileSync(file, `${lines.join('\n')}\n`)
}
