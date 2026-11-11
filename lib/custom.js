/**
 * User-defined balance sources.
 *
 * A custom source is a GET URL plus a JSON path to one number. Its headers may
 * carry a token, so the whole document lives in the plugin's private
 * `custom-sources.json` (0600) rather than the non-secret settings file; the
 * browser only ever receives header names and masks.
 *
 * The fetch path is deliberately narrow: http(s) only, no URL userinfo, a
 * 5-second deadline, a single attempt, a response-size cap, and an explicit
 * set of JSON path / value errors. It never returns the raw response.
 */
import { createHash, randomBytes } from 'node:crypto'

import { RemoteError, requestJson } from './remote.js'

/** At most this many custom sources may be configured. */
export const MAX_CUSTOM_SOURCES = 8

/** Id shape owned by the plugin. */
const ID_PATTERN = /^custom-[0-9a-f]{8}$/

/** Header names the fetch layer owns; a user source may not override them. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])

/** @returns a trimmed string or ''. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Validate the display name.
 * @param value - raw input.
 */
export function validateName(value) {
  const name = text(value)
  if (name === '' || name.length > 40) return { ok: false, code: 'invalid-custom-name' }
  return { ok: true, value: name }
}

/**
 * Validate a custom-source URL: http(s), no credentials, no control characters.
 * @param value - raw input.
 */
export function validateCustomUrl(value) {
  const raw = text(value)
  if (raw === '' || raw.length > 2048 || /[\r\n]/.test(raw)) {
    return { ok: false, code: 'invalid-custom-url' }
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, code: 'invalid-custom-url' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'invalid-custom-url' }
  }
  if (url.username !== '' || url.password !== '') return { ok: false, code: 'invalid-custom-url' }
  if (url.hostname === '') return { ok: false, code: 'invalid-custom-url' }
  return { ok: true, value: url.toString() }
}

/**
 * Validate headers as `[{ name, value }]`.
 * @param value - raw header list.
 */
export function validateHeaders(value) {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, code: 'invalid-custom-header' }
  if (value.length > 20) return { ok: false, code: 'invalid-custom-header' }
  const seen = new Map()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return { ok: false, code: 'invalid-custom-header' }
    const name = text(entry.name)
    const headerValue = typeof entry.value === 'string' ? entry.value : ''
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return { ok: false, code: 'invalid-custom-header' }
    if (RESERVED_HEADERS.has(name.toLowerCase())) return { ok: false, code: 'invalid-custom-header' }
    if (headerValue.length > 2048 || /[\r\n]/.test(headerValue)) {
      return { ok: false, code: 'invalid-custom-header' }
    }
    seen.set(name.toLowerCase(), { name, value: headerValue })
  }
  return { ok: true, value: [...seen.values()] }
}

/** @returns the path segments, or null when the syntax is not supported. */
function parseJsonPath(path) {
  if (typeof path !== 'string' || path === '' || path.length > 200) return null
  const segments = []
  for (const part of path.split('.')) {
    const match = /^([A-Za-z0-9_$-]+)((?:\[\d+\])*)$/.exec(part)
    if (match === null) return null
    segments.push(match[1])
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) segments.push(Number(index[1]))
  }
  return segments.length === 0 ? null : segments
}

/**
 * Validate the JSON path syntax (`data.balance`, `items[0].amount`).
 * @param value - raw input.
 */
export function validateValuePath(value) {
  const path = text(value)
  return parseJsonPath(path) === null ? { ok: false, code: 'invalid-custom-path' } : { ok: true, value: path }
}

/** @returns a three-letter currency, or CNY. */
export function normalizeCurrency(value) {
  const raw = text(value).toUpperCase()
  return /^[A-Z]{3}$/.test(raw) ? raw : 'CNY'
}

/**
 * Resolve a dotted/indexed path in a JSON value.
 * @param root - parsed JSON.
 * @param path - validated path.
 * @returns the value, or undefined.
 */
export function resolveJsonPath(root, path) {
  let current = root
  const segments = parseJsonPath(path)
  if (segments === null) return undefined
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined
      current = current[segment]
    } else {
      if (typeof current !== 'object' || Array.isArray(current)) return undefined
      current = current[segment]
    }
  }
  return current
}

/**
 * Parse a JSON value as a number, accepting numeric strings with grouping.
 * @param value - the extracted JSON value.
 * @returns a finite number, or null.
 */
export function numberFromJson(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.trim().replace(/,/g, '').replace(/^[¥￥$]\s*/, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : null
}

/** @returns a short header mask such as `…abcd`. */
export function maskHeaderValue(value) {
  const raw = typeof value === 'string' ? value : ''
  if (raw === '') return ''
  return raw.length <= 8 ? '••••' : `…${raw.slice(-4)}`
}

/** @returns the public projection (never header values). */
export function publicCustomSource(source) {
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    valuePath: source.valuePath,
    currency: source.currency,
    headers: source.headers.map((header) => ({ name: header.name, masked: maskHeaderValue(header.value) }))
  }
}

/**
 * Normalize one stored source. Invalid stored sources are ignored.
 * @param raw - one entry from disk.
 * @returns a clean source, or null.
 */
export function normalizeCustomSource(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = text(raw.id)
  const name = validateName(raw.name)
  const url = validateCustomUrl(raw.url)
  const valuePath = validateValuePath(raw.valuePath)
  const headers = validateHeaders(Array.isArray(raw.headers) ? raw.headers : [])
  if (!ID_PATTERN.test(id) || !name.ok || !url.ok || !valuePath.ok || !headers.ok) return null
  return {
    id,
    name: name.value,
    url: url.value,
    valuePath: valuePath.value,
    currency: normalizeCurrency(raw.currency),
    headers: headers.value
  }
}

/** @returns a fingerprint of the fields that affect the reply. */
export function customFingerprint(source) {
  const headers = [...source.headers]
    .map((header) => [header.name.toLowerCase(), header.value])
    .sort((left, right) => left[0].localeCompare(right[0]))
  return createHash('sha256')
    .update(JSON.stringify({ url: source.url, valuePath: source.valuePath, currency: source.currency, headers }))
    .digest('hex')
    .slice(0, 16)
}

/** @returns a fresh unique id. */
export function generateCustomId(sources) {
  const used = new Set(sources.map((source) => source.id))
  for (;;) {
    const id = `custom-${randomBytes(4).toString('hex')}`
    if (!used.has(id)) return id
  }
}

/**
 * Fold a save patch into one source.
 * @param patch - `{ id?, name, url, headers?, valuePath, currency? }`.
 * @param existing - the source being edited, when updating.
 * @param sources - all current sources (for id generation/uniqueness).
 * @returns `{ ok: true, source }` or `{ ok: false, code }`.
 */
export function buildCustomSource(patch, existing, sources) {
  const name = validateName(patch?.name)
  if (!name.ok) return name
  const url = validateCustomUrl(patch?.url)
  if (!url.ok) return url
  const valuePath = validateValuePath(patch?.valuePath)
  if (!valuePath.ok) return valuePath
  let headers
  if (patch?.headers === undefined) {
    headers = existing === undefined ? { ok: true, value: [] } : { ok: true, value: existing.headers }
  } else {
    headers = validateHeaders(patch.headers)
  }
  if (!headers.ok) return headers
  const id = existing === undefined ? generateCustomId(sources) : existing.id
  return {
    ok: true,
    source: {
      id,
      name: name.value,
      url: url.value,
      valuePath: valuePath.value,
      currency: normalizeCurrency(patch?.currency ?? existing?.currency),
      headers: headers.value
    }
  }
}

/**
 * Fetch one custom source and extract its number.
 * @param source - a validated source.
 * @param options - `{ timeoutMs, fetchImpl?, }`.
 * @returns `{ data: { value, currency }, ms }`.
 */
export async function fetchCustomSource(source, options) {
  const headers = {}
  for (const header of source.headers) headers[header.name] = header.value
  const reply = await requestJson({
    url: source.url,
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  })
  if (reply.status === 401 || reply.status === 403) {
    throw new RemoteError('custom-auth', 'the custom source rejected the request', reply.status)
  }
  if (reply.status === 429) {
    throw new RemoteError('rate-limited', 'the custom source rate-limited the request', reply.status)
  }
  if (reply.status >= 500) {
    throw new RemoteError('server-error', `the custom source answered HTTP ${reply.status}`, reply.status)
  }
  if (reply.status < 200 || reply.status >= 300) {
    throw new RemoteError('custom-http', `the custom source answered HTTP ${reply.status}`, reply.status)
  }
  if (reply.body === null || typeof reply.body !== 'object') {
    throw new RemoteError('bad-response', 'the custom source did not return JSON')
  }
  const extracted = resolveJsonPath(reply.body, source.valuePath)
  if (extracted === undefined) {
    throw new RemoteError('custom-path', 'the JSON path did not resolve')
  }
  const value = numberFromJson(extracted)
  if (value === null) {
    throw new RemoteError('custom-value', 'the JSON path did not resolve to a number')
  }
  return { data: { value, currency: source.currency }, ms: reply.ms }
}
