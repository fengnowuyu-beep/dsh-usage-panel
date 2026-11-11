/**
 * dsh-usage-panel — DSH's local usage ledger.
 *
 * The harness owns `<DSH_HOME>/dsh-usage/usage-ledger.json` and rewrites it as
 * calls settle. The plugin only reads it. Shape (version 1):
 *
 *   { version: 1,
 *     days: { "YYYY-MM-DD": { <provider>: { <model>: {
 *       inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *       reasoningTokens, calls, cost } } } } }
 *
 * `cost` is the harness's own figure for that model on that day, so the panel
 * never re-prices anything: the card reports what DSH already computed. Days
 * the harness has not written are simply absent, which reads as zero — not as
 * an error — because a quiet day is not a broken ledger.
 */
import { readFileSync, statSync } from 'node:fs'

/** How many trailing days the card's sparkline covers. */
export const TREND_DAYS = 7

/** @returns `YYYY-MM-DD` in local time, matching the harness's day keys. */
export function localDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** @returns `YYYY-MM` in local time. */
export function localMonthKey(date) {
  return localDateKey(date).slice(0, 7)
}

/** @returns a new Date `delta` days from `date`, at local midnight. */
function shiftDay(date, delta) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)
}

/** A fresh accumulator. */
function emptyBucket() {
  return { cost: 0, calls: 0, tokens: 0 }
}

/**
 * Accumulate one model entry into a bucket.
 * @param bucket - the accumulator.
 * @param entry - one `{ model }` record from the ledger.
 */
function addEntry(bucket, entry) {
  if (entry === null || typeof entry !== 'object') return
  const cost = Number(entry.cost)
  const calls = Number(entry.calls)
  if (Number.isFinite(cost)) bucket.cost += cost
  if (Number.isFinite(calls)) bucket.calls += calls
  const tokens = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    .map((field) => Number(entry[field]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value, 0)
  bucket.tokens += tokens
}

/**
 * Walk one day's providers/models.
 * @param day - the day's nested object.
 * @param visit - called once per model entry with `(providerName, entry, modelName)`.
 */
function eachEntry(day, visit) {
  if (day === null || typeof day !== 'object') return
  for (const [provider, models] of Object.entries(day)) {
    if (models === null || typeof models !== 'object') continue
    for (const [model, entry] of Object.entries(models)) visit(provider, entry, model)
  }
}

/** @returns true when a provider key names DeepSeek. */
export function isDeepSeekProvider(name) {
  return typeof name === 'string' && name.toLowerCase().includes('deepseek')
}

/**
 * Human-facing names for the provider ids the ledger uses. An unknown provider
 * keeps its raw id: a wrong pretty name would be worse than an honest one.
 * @param name - the ledger's provider key.
 * @returns the display name.
 */
export function providerDisplayName(name) {
  const raw = typeof name === 'string' ? name : String(name ?? '')
  const key = raw.toLowerCase()
  const known = {
    'deepseek-account': 'DeepSeek',
    deepseek: 'DeepSeek',
    minimax: 'MiniMax',
    'minimax-cn': 'MiniMax',
    moonshotai: 'Kimi',
    'moonshotai-cn': 'Kimi',
    zai: 'GLM',
    'zai-coding-cn': 'GLM',
    openai: 'OpenAI',
    openrouter: 'OpenRouter'
  }
  if (known[key] !== undefined) return known[key]
  if (key.includes('deepseek')) return 'DeepSeek'
  if (key.includes('minimax')) return 'MiniMax'
  if (key.includes('moonshot') || key.includes('kimi')) return 'Kimi'
  return raw
}

/**
 * Project the ledger document onto the panel's card shape.
 * @param document - the parsed ledger, or anything that was read from disk.
 * @param now - the clock to compute "today" and "this month" from.
 * @returns the summary (always a complete object, even for a broken document).
 */
export function summarizeLedger(document, now = new Date()) {
  const days = document !== null && typeof document === 'object' && document.days !== null && typeof document.days === 'object'
    ? document.days
    : null
  if (days === null) {
    return {
      available: false,
      today: emptyBucket(),
      month: emptyBucket(),
      series: buildSeries({}, now),
      deepseek: { today: emptyBucket(), month: emptyBucket(), series: buildSeries({}, now) },
      providers: [],
      models: []
    }
  }

  const todayKey = localDateKey(now)
  const monthKey = localMonthKey(now)
  const today = emptyBucket()
  const month = emptyBucket()
  const deepseekToday = emptyBucket()
  const deepseekMonth = emptyBucket()
  const providers = new Map()
  const models = new Map()

  for (const [dateKey, day] of Object.entries(days)) {
    const isMonth = typeof dateKey === 'string' && dateKey.startsWith(monthKey)
    const isToday = dateKey === todayKey
    if (!isMonth && !isToday) continue
    eachEntry(day, (provider, entry, model) => {
      if (isMonth) addEntry(month, entry)
      // `today` can fall outside `month` only across a month boundary bug; adding
      // it independently keeps the two figures honest.
      if (isToday) addEntry(today, entry)
      if (!providers.has(provider)) providers.set(provider, { name: provider, today: emptyBucket(), month: emptyBucket() })
      const bucket = providers.get(provider)
      if (isMonth) addEntry(bucket.month, entry)
      if (isToday) addEntry(bucket.today, entry)
      if (isMonth) {
        const key = `${provider}\u0000${model}`
        if (!models.has(key)) {
          models.set(key, { provider, providerName: providerDisplayName(provider), model, cost: 0, calls: 0, tokens: 0 })
        }
        addEntry(models.get(key), entry)
      }
      if (isDeepSeekProvider(provider)) {
        if (isMonth) addEntry(deepseekMonth, entry)
        if (isToday) addEntry(deepseekToday, entry)
      }
    })
  }

  return {
    available: true,
    today,
    month,
    series: buildSeries(days, now),
    deepseek: {
      today: deepseekToday,
      month: deepseekMonth,
      series: buildSeries(days, now, isDeepSeekProvider)
    },
    providers: [...providers.values()]
      .map((entry) => ({
        name: entry.name,
        providerName: providerDisplayName(entry.name),
        today: { cost: entry.today.cost, calls: entry.today.calls },
        month: { cost: entry.month.cost, calls: entry.month.calls }
      }))
      .sort((left, right) => right.month.cost - left.month.cost),
    models: [...models.values()]
      .map((entry) => ({
        provider: entry.provider,
        providerName: entry.providerName,
        model: entry.model,
        cost: entry.cost,
        calls: entry.calls,
        tokens: entry.tokens
      }))
      .sort((left, right) => right.cost - left.cost)
  }
}

/**
 * Build the trailing {@link TREND_DAYS}-day series, oldest first.
 * @param days - the ledger's `days` map.
 * @param now - the clock.
 * @param keep - optional provider filter; entries are only counted when it says yes.
 * @returns `[{ date, cost, calls }]`.
 */
function buildSeries(days, now, keep = () => true) {
  const series = []
  for (let offset = TREND_DAYS - 1; offset >= 0; offset -= 1) {
    const date = shiftDay(now, -offset)
    const key = localDateKey(date)
    const bucket = emptyBucket()
    const day = days[key]
    if (day !== null && typeof day === 'object') {
      eachEntry(day, (provider, entry) => {
        if (keep(provider)) addEntry(bucket, entry)
      })
    }
    series.push({ date: key, cost: bucket.cost, calls: bucket.calls })
  }
  return series
}

/**
 * Read and summarize the ledger file in one step. A missing file and an
 * unreadable file are distinct: the first is a fresh install, the second is a
 * transient write or a corrupt document worth surfacing.
 * @param file - the absolute ledger path.
 * @param now - the clock.
 * @returns `{ available, updatedAt, error, ...summary }`.
 */
export function readLedger(file, now = new Date()) {
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    const code = error !== null && typeof error === 'object' && error.code === 'ENOENT' ? 'missing' : 'unreadable'
    return { ...summarizeLedger(null, now), available: false, updatedAt: null, error: { code } }
  }
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...summarizeLedger(null, now), available: false, updatedAt: stat.mtimeMs, error: { code: 'unreadable' } }
  }
  if (document === null || typeof document !== 'object' || document.days === null || typeof document.days !== 'object') {
    return { ...summarizeLedger(null, now), available: false, updatedAt: stat.mtimeMs, error: { code: 'bad-shape' } }
  }
  return {
    ...summarizeLedger(document, now),
    available: true,
    updatedAt: stat.mtimeMs,
    error: null
  }
}
