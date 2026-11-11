/**
 * Per-call pricing for the session-statistics feature.
 *
 * The table is DeepSeek's published CNY list price for the two models the
 * official route serves, checked against the vendor's pricing page on
 * 2026-11-11: peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through
 * Friday, and every other hour is billed at half the peak rate. Chinese public
 * holidays are *not* modelled (the vendor excludes them); a holiday call is
 * therefore priced as a weekday call. The panel labels every session figure
 * 「估算」 for exactly this reason.
 *
 * The ledger already carries DSH's own daily cost; this table exists only for
 * the per-session split, which the ledger does not store.
 */

/** Every rate in this document is quoted per this many tokens. */
export const PRICE_UNIT = 1_000_000

/** Peak windows in UTC, Monday through Friday. */
export const PEAK_WINDOWS_UTC = Object.freeze([
  Object.freeze({ start: '01:00', end: '04:00' }),
  Object.freeze({ start: '06:00', end: '10:00' })
])

/** Peak weekdays, as `Date#getUTCDay` values (1 = Monday … 5 = Friday). */
export const PEAK_WEEKDAYS_UTC = Object.freeze([1, 2, 3, 4, 5])

/** Retired model names the vendor still bills at a successor's price. */
export const MODEL_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash'
})

/** The built-in CNY table. */
export const PRICES = Object.freeze({
  'deepseek-flash': Object.freeze({
    displayName: 'DeepSeek-V4.1-Flash',
    cacheHit: Object.freeze({ offPeak: 0.02, peak: 0.04 }),
    cacheMiss: Object.freeze({ offPeak: 1, peak: 2 }),
    output: Object.freeze({ offPeak: 4, peak: 8 }),
    cacheWrite: null
  }),
  'deepseek-v4-pro': Object.freeze({
    displayName: 'DeepSeek-V4-Pro',
    cacheHit: Object.freeze({ offPeak: 0.15, peak: 0.3 }),
    cacheMiss: Object.freeze({ offPeak: 4.5, peak: 9 }),
    output: Object.freeze({ offPeak: 13.5, peak: 27 }),
    cacheWrite: null
  })
})

/** Metadata shown next to session figures. */
export const PRICING_META = Object.freeze({
  label: 'DeepSeek 官方标价（CNY，2026-10-08 版）',
  updatedAt: '2026-10-08',
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  currency: 'CNY',
  note: '周末与工作日非高峰按半价；中国法定节假日未建模'
})

/** @returns the canonical model name, or the input when unknown. */
export function normalizeModel(model) {
  const name = typeof model === 'string' ? model.trim().toLowerCase() : ''
  return MODEL_ALIASES[name] ?? name
}

/** @returns true when the instant falls inside a peak window. */
export function isPeakInstant(atMs) {
  const date = new Date(atMs)
  if (!Number.isFinite(date.getTime())) return false
  if (!PEAK_WEEKDAYS_UTC.includes(date.getUTCDay())) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  return PEAK_WINDOWS_UTC.some((window) => {
    const [startHour, startMinute] = window.start.split(':').map(Number)
    const [endHour, endMinute] = window.end.split(':').map(Number)
    return minutes >= startHour * 60 + startMinute && minutes < endHour * 60 + endMinute
  })
}

/** @returns the number of tokens a usage record describes. */
export function totalTokens(usage) {
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .map((field) => Number(usage?.[field]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value, 0)
}

/**
 * Price one usage record at one instant.
 *
 * `inputTokens` is the uncached input (the harness's own bucket), and
 * `cacheReadTokens` is priced at the cache-hit rate. A model without an entry
 * is reported as unpriced rather than given an invented number.
 *
 * @param model - the model id from the session event.
 * @param usage - `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`.
 * @param atMs - the event timestamp, in milliseconds.
 * @returns `{ cost, tokens, unpricedTokens, priced, model }`.
 */
export function usageCost(model, usage, atMs) {
  const name = normalizeModel(model)
  const entry = PRICES[name]
  const tokens = totalTokens(usage)
  if (entry === undefined) {
    return { cost: 0, tokens, unpricedTokens: tokens, priced: false, model: name }
  }
  const peak = isPeakInstant(atMs)
  const mode = peak ? 'peak' : 'offPeak'
  const cacheHit = Math.max(0, Number(usage?.cacheReadTokens) || 0)
  const cacheMiss = Math.max(0, Number(usage?.inputTokens) || 0)
  const output = Math.max(0, Number(usage?.outputTokens) || 0)
  const cacheWrite = Math.max(0, Number(usage?.cacheWriteTokens) || 0)
  const cost = (
    cacheHit * entry.cacheHit[mode]
    + cacheMiss * entry.cacheMiss[mode]
    + output * entry.output[mode]
  ) / PRICE_UNIT
  const cacheWriteRate = entry.cacheWrite === null ? null : entry.cacheWrite[mode]
  const unpricedTokens = cacheWriteRate === null ? cacheWrite : 0
  const pricedCost = cacheWriteRate === null ? cost : cost + (cacheWrite * cacheWriteRate) / PRICE_UNIT
  return { cost: pricedCost, tokens, unpricedTokens, priced: true, model: name }
}
