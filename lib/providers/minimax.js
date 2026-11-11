/**
 * MiniMax Token Plan quota adapter.
 *
 * Endpoint (verified 2026-11-11 against MiniMax's FAQ and community probes):
 *   GET https://www.minimax.cn/v1/token_plan/remains        (CN)
 *   GET https://www.minimax.io/v1/token_plan/remains        (global)
 *   Authorization: Bearer <subscription key>
 *
 * The response is `{ base_resp: { status_code, status_msg }, model_remains: [...] }`.
 * The count fields have a history of changing meaning: on the current endpoint
 * `current_interval_usage_count` is treated as **used**, which is also what the
 * requirements document says. When the payload carries an explicit
 * `*_remaining_percent`, that unambiguous value wins; raw used/total are kept so
 * a semantics change cannot silently invert the display.
 */
import { RemoteError, requestJson } from '../remote.js'

/** Region bases. The user can choose either; CN is the default. */
export const MINIMAX_BASES = Object.freeze({
  cn: 'https://www.minimax.cn',
  global: 'https://www.minimax.io'
})

/** @returns a finite number, or null. */
function numberish(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** @returns a 0–100 percentage rounded to one decimal, or null. */
function percent(value) {
  const parsed = numberish(value)
  if (parsed === null) return null
  return Math.round(Math.max(0, Math.min(100, parsed)) * 10) / 10
}

/** @returns epoch milliseconds, or null. */
function epoch(value) {
  const parsed = numberish(value)
  if (parsed === null) return null
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed
}

/**
 * Build one window from the interval/weekly field families.
 * @param entry - one `model_remains[]` object.
 * @param prefix - `current_interval` / `current_weekly`.
 * @param suffix - `end_time` / `remains_time` etc. handled by caller.
 * @returns `{ total, used, remainingPercent, usedPercent, startAt, endAt, remainsAt }`.
 */
function windowOf(entry, prefix) {
  const total = numberish(entry[`${prefix}_total_count`])
  const used = numberish(entry[`${prefix}_usage_count`])
  const explicitRemaining = percent(entry[`${prefix}_remaining_percent`])
  const computedRemaining = total !== null && total > 0 && used !== null
    ? Math.round(Math.max(0, Math.min(100, 100 - (used / total) * 100)) * 10) / 10
    : null
  const remainingPercent = explicitRemaining ?? computedRemaining
  const usedPercent = remainingPercent === null ? null : Math.round((100 - remainingPercent) * 10) / 10
  const fallback = prefix === 'current_interval'
  return {
    total,
    used,
    remainingPercent,
    usedPercent,
    startAt: epoch(entry[`${prefix}_start_time`] ?? (fallback ? entry.start_time : undefined)),
    endAt: epoch(entry[`${prefix}_end_time`] ?? (fallback ? entry.end_time : undefined)),
    remainsAt: epoch(entry[`${prefix}_remains_time`] ?? (fallback ? entry.remains_time : undefined))
  }
}

/**
 * Classify a `base_resp.status_code != 0` payload.
 * @param status - the numeric status code.
 * @param message - the provider's message.
 * @returns a {@link RemoteError}.
 */
function baseRespError(status, message) {
  const text = String(message ?? '').toLowerCase()
  const looksLikePlan = /(plan|subscri|套餐|订阅|quota)/.test(text)
  const looksLikeAuth = /(auth|invalid key|api key|token|login|expired|unauthor|401|403|1004)/.test(text)
  if (looksLikePlan && !looksLikeAuth) {
    return new RemoteError('minimax-no-plan', 'this key has no Token Plan subscription quota')
  }
  if (looksLikeAuth) {
    return new RemoteError('minimax-auth', 'the MiniMax key or session was rejected')
  }
  if (looksLikePlan) {
    return new RemoteError('minimax-no-plan', 'this key has no Token Plan subscription quota')
  }
  return new RemoteError('minimax-api', `MiniMax answered status ${status}`)
}

/**
 * Turn a Token Plan payload into the card shape.
 * @param payload - the parsed JSON body.
 * @returns `{ plan, models, primary }`.
 * @throws {RemoteError} auth / no-plan / empty / bad-response.
 */
export function normalizeMinimaxQuota(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RemoteError('bad-response', 'MiniMax reply is not an object')
  }
  const base = payload.base_resp
  if (base !== null && typeof base === 'object') {
    const status = numberish(base.status_code)
    if (status !== null && status !== 0) {
      throw baseRespError(status, base.status_msg)
    }
  }
  const rows = Array.isArray(payload.model_remains) ? payload.model_remains : null
  if (rows === null) throw new RemoteError('bad-response', 'MiniMax reply has no model_remains array')
  if (rows.length === 0) throw new RemoteError('minimax-empty', 'MiniMax returned no subscription windows')

  const models = rows.map((row, index) => {
    const entry = row !== null && typeof row === 'object' ? row : {}
    return {
      name: typeof entry.model_name === 'string' && entry.model_name !== '' ? entry.model_name : `model-${index + 1}`,
      plan: typeof entry.current_subscribe_title === 'string'
        ? entry.current_subscribe_title
        : typeof entry.plan_name === 'string' ? entry.plan_name : '',
      interval: windowOf(entry, 'current_interval'),
      weekly: windowOf(entry, 'current_weekly')
    }
  })

  const withPercent = models.filter((model) => model.interval.remainingPercent !== null)
  const primary = withPercent.length > 0
    ? withPercent.reduce((lowest, model) => (
        model.interval.remainingPercent < lowest.interval.remainingPercent ? model : lowest
      ))
    : models[0]

  return {
    plan: models.find((model) => model.plan !== '')?.plan ?? '',
    models,
    primary
  }
}

/**
 * Fetch the Token Plan quota once.
 * @param options - `{ apiKey, region, timeoutMs, fetchImpl? }`.
 * @returns `{ quota, ms }`.
 */
export async function fetchMinimaxQuota(options) {
  const apiKey = options.apiKey
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new RemoteError('no-key', 'no MiniMax API key is configured')
  }
  const base = MINIMAX_BASES[options.region] ?? MINIMAX_BASES.cn
  const reply = await requestJson({
    url: `${base}/v1/token_plan/remains`,
    method: 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      'content-type': 'application/json'
    },
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  })
  if (reply.status === 401 || reply.status === 403) {
    throw new RemoteError('minimax-auth', 'the MiniMax key was rejected', reply.status)
  }
  if (reply.status === 429) {
    throw new RemoteError('rate-limited', 'the MiniMax endpoint rate-limited the request', reply.status)
  }
  if (reply.status >= 500) {
    throw new RemoteError('server-error', `MiniMax answered HTTP ${reply.status}`, reply.status)
  }
  if (reply.status < 200 || reply.status >= 300) {
    throw new RemoteError('http-error', `MiniMax answered HTTP ${reply.status}`, reply.status)
  }
  return { quota: normalizeMinimaxQuota(reply.body), ms: reply.ms }
}
