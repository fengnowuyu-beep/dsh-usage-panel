/**
 * dsh-usage-panel — the DeepSeek balance probe.
 *
 * One GET against the documented `GET /user/balance` endpoint, with a hard
 * deadline and no retries. The API key lives in the request header only: it is
 * never logged, never returned in an error, and never reaches the browser half.
 *
 * Response contract (verified 2026-11-11 against
 * https://api-docs.deepseek.com/api/get-user-balance):
 *
 *   { is_available: boolean,
 *     balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * Every numeric field is a decimal *string*, so each one is parsed and a value
 * that cannot be parsed fails the card instead of rendering `NaN`.
 */

import { RemoteError, transportError } from './remote.js'

export { RemoteError }

/** The documented endpoint, appended to the configured base URL. */
export const BALANCE_PATH = '/user/balance'

/** Refuse a reply larger than this; the real one is a few hundred bytes. */
const MAX_RESPONSE_CHARS = 1_000_000

/**
 * Parse one decimal field.
 * @param value - a string or number from the reply.
 * @returns the finite number, or `null`.
 */
function decimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Turn a raw reply into the card's shape. Exported for the offline tests.
 * @param body - the parsed JSON body.
 * @param preferredCurrency - the account currency to show as the main number.
 * @returns `{ isAvailable, primary, items }`.
 * @throws {RemoteError} `bad-response` / `empty-balance` when the shape is wrong.
 */
export function normalizeBalance(body, preferredCurrency = 'CNY') {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RemoteError('bad-response', 'balance reply is not an object')
  }
  if (!Array.isArray(body.balance_infos)) {
    throw new RemoteError('bad-response', 'balance reply has no balance_infos array')
  }
  const items = []
  for (const info of body.balance_infos) {
    if (info === null || typeof info !== 'object') continue
    const currency = typeof info.currency === 'string' ? info.currency.trim().toUpperCase() : ''
    const total = decimal(info.total_balance)
    if (currency === '' || total === null) continue
    items.push({
      currency,
      total,
      granted: decimal(info.granted_balance),
      toppedUp: decimal(info.topped_up_balance)
    })
  }
  if (items.length === 0) {
    throw new RemoteError('empty-balance', 'balance reply carries no usable currency entry')
  }
  const wanted = typeof preferredCurrency === 'string' ? preferredCurrency.trim().toUpperCase() : ''
  const primary = items.find((item) => item.currency === wanted) ?? items[0]
  return {
    isAvailable: body.is_available !== false,
    primary,
    items
  }
}

/**
 * Map a non-2xx status onto a stable code.
 * @param status - the HTTP status.
 * @returns a {@link RemoteError}.
 */
function statusError(status) {
  if (status === 401) return new RemoteError('unauthorized', 'the API key was rejected', status)
  if (status === 403) return new RemoteError('forbidden', 'the API key is not allowed to read the balance', status)
  if (status === 429) return new RemoteError('rate-limited', 'the balance endpoint rate-limited the request', status)
  if (status >= 500) return new RemoteError('server-error', `the API host answered HTTP ${status}`, status)
  return new RemoteError('http-error', `the API host answered HTTP ${status}`, status)
}

/**
 * Fetch the DeepSeek balance once.
 *
 * The deadline is enforced by both an AbortController and a race with a timer:
 * a fetch implementation that ignores the abort signal still cannot hang the
 * route. The timer promise is cleared on every exit path.
 *
 * @param options - `{ apiKey, baseUrl, timeoutMs, fetchImpl?, preferredCurrency? }`.
 * @returns `{ balance, ms, status }`.
 * @throws {RemoteError} a classified failure; never the key.
 */
export async function fetchBalance(options) {
  const { apiKey, baseUrl, timeoutMs } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const preferredCurrency = options.preferredCurrency ?? 'CNY'
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new RemoteError('no-key', 'no DeepSeek API key is configured')
  }
  if (typeof fetchImpl !== 'function') {
    throw new RemoteError('network', 'this Node runtime has no fetch implementation')
  }

  let url
  try {
    url = new URL(BALANCE_PATH, `${String(baseUrl).replace(/\/+$/, '')}/`)
  } catch {
    throw new RemoteError('invalid-base-url', 'the configured API root is not a URL')
  }

  const started = Date.now()
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RemoteError('timeout', `no reply within ${timeoutMs} ms`))
    }, timeoutMs)
  })

  const request = (async () => {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'user-agent': 'dsh-usage-panel/0.2.0'
      },
      signal: controller.signal
    })
    if (!response.ok) throw statusError(response.status)
    const text = await response.text()
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new RemoteError('bad-response', 'balance reply is unexpectedly large')
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new RemoteError('bad-response', 'balance reply is not JSON')
    }
    return { balance: normalizeBalance(parsed, preferredCurrency), status: response.status }
  })().catch((error) => {
    if (error instanceof RemoteError) throw error
    throw transportError(error)
  })

  try {
    const reply = await Promise.race([request, deadline])
    return { ...reply, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
