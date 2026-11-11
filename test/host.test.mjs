/**
 * Host half: configuration, the DeepSeek probe, the ledger projection, the
 * engine's cache/degradation behaviour and the route fence.
 *
 * Everything runs offline: `fetch` is replaced by recorders, and every write
 * goes to a throwaway `<DSH_HOME>` under the OS temp directory.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { deepEqual, equal, ok, rejects, run, test } from './harness.mjs'
import {
  DEFAULT_SETTINGS,
  MAX_TIMEOUT_MS,
  clearBalanceCache,
  credentialsPath,
  keyFingerprint,
  loadBalanceCache,
  loadCredentials,
  loadSettings,
  maskKey,
  normalizeBaseUrl,
  normalizeSettings,
  normalizeTimeout,
  resolveApiKey,
  saveBalanceCache,
  saveCredentials,
  saveSettings,
  settingsPath,
  validateApiKey,
  validateBaseUrl
} from '../lib/config.js'
import { RemoteError, fetchBalance, normalizeBalance } from '../lib/deepseek.js'
import { localDateKey, localMonthKey, readLedger, summarizeLedger } from '../lib/ledger.js'
import { ROUTE_PREFIX, UsagePanel, apply } from '../lib/index.js'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

// The route tests mount through `apply()`, which reads the process environment.
// A developer machine with DEEPSEEK_API_KEY exported must not change the
// expectations, so this suite owns that variable.
delete process.env.DEEPSEEK_API_KEY

/** A fresh throwaway harness home. */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-usage-panel-test-'))
}

/** Nov 11 2026, local noon: the fixed clock the ledger tests use. */
const FIXED_NOW = new Date(2026, 10, 11, 12, 0, 0)

/** The documented balance reply. */
const BALANCE_DOC = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }
  ]
}

/** A recorded fetch that always answers with one JSON body. */
function jsonFetch(document, options = {}) {
  const status = options.status ?? 200
  const delay = options.delay ?? 0
  const calls = { count: 0, urls: [], headers: [] }
  const impl = async (url, init) => {
    calls.count += 1
    calls.urls.push(String(url))
    calls.headers.push(init?.headers ?? {})
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(document)
    }
  }
  return { impl, calls }
}

/** A fetch that rejects like an unreachable host. */
function failingFetch(code = 'EAI_AGAIN') {
  const calls = { count: 0 }
  const impl = async () => {
    calls.count += 1
    const error = new TypeError('fetch failed')
    error.cause = { code }
    throw error
  }
  return { impl, calls }
}

/** A fetch that honours AbortSignal and never answers otherwise. */
function hangingFetch() {
  return async (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}

/** Write a ledger document into a throwaway home. */
function writeLedger(home, document) {
  mkdirSync(join(home, 'dsh-usage'), { recursive: true })
  writeFileSync(join(home, 'dsh-usage', 'usage-ledger.json'), JSON.stringify(document))
}

/** The ledger fixture: two months, two providers, some quiet days. */
const LEDGER_DOC = {
  version: 1,
  days: {
    '2026-09-15': { 'deepseek-account': { 'deepseek-flash': { cost: 9, calls: 9 } } },
    '2026-10-31': { 'deepseek-account': { 'deepseek-flash': { cost: 5, calls: 5 } } },
    '2026-11-05': { 'deepseek-account': { 'deepseek-flash': { inputTokens: 100, outputTokens: 50, cost: 1.5, calls: 3 } } },
    '2026-11-10': {
      'deepseek-account': { 'deepseek-v4-pro': { cost: 2.25, calls: 7 } },
      minimax: { abab: { cost: 4, calls: 2 } }
    },
    '2026-11-11': {
      'deepseek-account': { 'deepseek-flash': { cost: 1.25, calls: 10 } },
      minimax: { abab: { cost: 0.5, calls: 1 } }
    }
  }
}

// ── configuration ───────────────────────────────────────────────────────────

console.log('# config')

test('normalizeBaseUrl keeps a clean root and drops query/hash/trailing slash', () => {
  equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com')
  equal(normalizeBaseUrl('https://api.deepseek.com/?a=1#b'), 'https://api.deepseek.com')
  equal(normalizeBaseUrl('http://127.0.0.1:8080/proxy'), 'http://127.0.0.1:8080/proxy')
})

test('normalizeBaseUrl falls back instead of throwing on hostile input', () => {
  equal(normalizeBaseUrl('javascript:alert(1)'), DEFAULT_SETTINGS.baseUrl)
  equal(normalizeBaseUrl('https://user:pass@api.deepseek.com'), DEFAULT_SETTINGS.baseUrl)
  equal(normalizeBaseUrl('not a url'), DEFAULT_SETTINGS.baseUrl)
  equal(normalizeBaseUrl(undefined), DEFAULT_SETTINGS.baseUrl)
})

test('validateBaseUrl reports what is wrong', () => {
  deepEqual(validateBaseUrl(''), { ok: true, value: DEFAULT_SETTINGS.baseUrl })
  equal(validateBaseUrl('ftp://x').ok, false)
  equal(validateBaseUrl('https://u:p@x').code, 'invalid-base-url')
  equal(validateBaseUrl('https://api.deepseek.com/').value, 'https://api.deepseek.com')
})

test('normalizeTimeout clamps to the 5-second contract', () => {
  equal(normalizeTimeout(99999), MAX_TIMEOUT_MS)
  equal(normalizeTimeout(100), 1000)
  equal(normalizeTimeout('2500'), 2500)
  equal(normalizeTimeout('nope'), MAX_TIMEOUT_MS)
})

test('normalizeSettings tolerates a hostile document', () => {
  const settings = normalizeSettings({ baseUrl: 42, timeoutMs: -1, currency: 'eur' })
  equal(settings.baseUrl, DEFAULT_SETTINGS.baseUrl)
  equal(settings.timeoutMs, 1000)
  equal(settings.currency, DEFAULT_SETTINGS.currency)
})

test('validateApiKey rejects whitespace and short keys, accepts empty', () => {
  deepEqual(validateApiKey(''), { ok: true, value: '' })
  equal(validateApiKey('sk-abc def').code, 'invalid-key')
  equal(validateApiKey('short').code, 'invalid-key')
  deepEqual(validateApiKey('  sk-abcdefghijk  '), { ok: true, value: 'sk-abcdefghijk' })
})

test('maskKey shows sk-…tail and never the whole key', () => {
  equal(maskKey('sk-1234567890abcdef'), 'sk-…cdef')
  equal(maskKey('short-key'), 's…ey')
  equal(maskKey(''), '')
})

test('keyFingerprint is stable and key-dependent', () => {
  equal(keyFingerprint('sk-a123456789'), keyFingerprint('sk-a123456789'))
  ok(keyFingerprint('sk-a123456789') !== keyFingerprint('sk-b123456789'))
  equal(keyFingerprint(''), '')
})

test('settings survive a save/load round trip', async () => {
  const home = tempHome()
  await saveSettings(home, { baseUrl: 'https://proxy.example', timeoutMs: 3000, currency: 'USD' })
  const loaded = loadSettings(home)
  equal(loaded.baseUrl, 'https://proxy.example')
  equal(loaded.timeoutMs, 3000)
  equal(loaded.currency, 'USD')
  ok(typeof loaded.savedAt === 'number')
})

test('credentials round-trip and never leak into the settings document', async () => {
  const home = tempHome()
  await saveCredentials(home, 'sk-secret-1234567890')
  deepEqual(loadCredentials(home).apiKey, 'sk-secret-1234567890')
  ok(existsSync(credentialsPath(home)))
  ok(!existsSync(settingsPath(home)))
  const raw = readFileSync(credentialsPath(home), 'utf8')
  ok(raw.includes('sk-secret-1234567890'), 'the private document is where the key lives')
})

test('resolveApiKey prefers the file, then the environment', async () => {
  const home = tempHome()
  deepEqual(resolveApiKey(home, {}), { apiKey: '', source: 'none', updatedAt: null })
  const fromEnv = resolveApiKey(home, { DEEPSEEK_API_KEY: 'sk-env-12345678' })
  equal(fromEnv.apiKey, 'sk-env-12345678')
  equal(fromEnv.source, 'env')
  await saveCredentials(home, 'sk-file-12345678')
  const fromFile = resolveApiKey(home, { DEEPSEEK_API_KEY: 'sk-env-12345678' })
  equal(fromFile.apiKey, 'sk-file-12345678')
  equal(fromFile.source, 'file')
})

test('balance cache round-trips and clears', async () => {
  const home = tempHome()
  await saveBalanceCache(home, {
    balance: { isAvailable: true, primary: { currency: 'CNY', total: 1, granted: 0, toppedUp: 1 }, items: [] },
    fetchedAt: 1234567890,
    fingerprint: 'abc'
  })
  const cache = loadBalanceCache(home)
  equal(cache.fetchedAt, 1234567890)
  equal(cache.fingerprint, 'abc')
  await clearBalanceCache(home)
  equal(loadBalanceCache(home), null)
})

// ── DeepSeek probe ──────────────────────────────────────────────────────────

console.log('# deepseek')

test('normalizeBalance parses the documented example', () => {
  const balance = normalizeBalance(BALANCE_DOC)
  equal(balance.isAvailable, true)
  equal(balance.primary.currency, 'CNY')
  equal(balance.primary.total, 110)
  equal(balance.primary.granted, 10)
  equal(balance.primary.toppedUp, 100)
})

test('normalizeBalance prefers the requested currency', () => {
  const balance = normalizeBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '5.00', granted_balance: '0', topped_up_balance: '5.00' },
      { currency: 'CNY', total_balance: '20.00', granted_balance: '0', topped_up_balance: '20.00' }
    ]
  }, 'CNY')
  equal(balance.primary.currency, 'CNY')
  equal(balance.items.length, 2)
  equal(balance.items[0].currency, 'USD')
})

test('normalizeBalance surfaces is_available=false', () => {
  const balance = normalizeBalance({ is_available: false, balance_infos: BALANCE_DOC.balance_infos })
  equal(balance.isAvailable, false)
})

test('normalizeBalance rejects broken shapes with stable codes', () => {
  for (const [body, code] of [
    [null, 'bad-response'],
    [{}, 'bad-response'],
    [{ balance_infos: [] }, 'empty-balance'],
    [{ balance_infos: [{ currency: 'CNY', total_balance: 'oops' }] }, 'empty-balance']
  ]) {
    let caught
    try {
      normalizeBalance(body)
    } catch (error) {
      caught = error
    }
    ok(caught instanceof RemoteError, `expected RemoteError for ${JSON.stringify(body)}`)
    equal(caught.code, code)
  }
})

test('fetchBalance sends Bearer auth to /user/balance', async () => {
  const recorder = jsonFetch(BALANCE_DOC)
  const result = await fetchBalance({
    apiKey: 'sk-abcd1234efgh',
    baseUrl: 'https://api.deepseek.com',
    timeoutMs: 500,
    fetchImpl: recorder.impl
  })
  equal(recorder.calls.urls[0], 'https://api.deepseek.com/user/balance')
  equal(recorder.calls.headers[0].authorization, 'Bearer sk-abcd1234efgh')
  equal(result.balance.primary.total, 110)
  ok(result.ms >= 0)
  equal(result.status, 200)
})

test('fetchBalance maps 401 without echoing the key', async () => {
  const recorder = jsonFetch({ error: 'unauthorized' }, { status: 401 })
  let caught
  try {
    await fetchBalance({ apiKey: 'sk-secret-value', baseUrl: 'https://api.deepseek.com', timeoutMs: 500, fetchImpl: recorder.impl })
  } catch (error) {
    caught = error
  }
  ok(caught instanceof RemoteError)
  equal(caught.code, 'unauthorized')
  equal(caught.status, 401)
  ok(!String(caught.message).includes('sk-secret-value'))
})

test('fetchBalance times out at the deadline', async () => {
  let caught
  const started = Date.now()
  try {
    await fetchBalance({ apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com', timeoutMs: 40, fetchImpl: hangingFetch() })
  } catch (error) {
    caught = error
  }
  ok(caught instanceof RemoteError)
  equal(caught.code, 'timeout')
  ok(Date.now() - started < 2000, 'the deadline must fire, not wait out the request')
})

test('fetchBalance survives a fetch that ignores AbortSignal', async () => {
  let caught
  try {
    await fetchBalance({
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      timeoutMs: 30,
      fetchImpl: () => new Promise(() => {})
    })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'timeout')
})

test('fetchBalance classifies transport failures', async () => {
  let caught
  try {
    await fetchBalance({ apiKey: 'sk-x', baseUrl: 'https://api.deepseek.com', timeoutMs: 500, fetchImpl: failingFetch('ENOTFOUND').impl })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'network')
})

test('fetchBalance reports a non-URL root instead of throwing a TypeError', async () => {
  let caught
  try {
    await fetchBalance({ apiKey: 'sk-x', baseUrl: '::::', timeoutMs: 500, fetchImpl: jsonFetch(BALANCE_DOC).impl })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'invalid-base-url')
})

// ── ledger ──────────────────────────────────────────────────────────────────

console.log('# ledger')

test('local date keys match the harness day format', () => {
  equal(localDateKey(FIXED_NOW), '2026-11-11')
  equal(localMonthKey(FIXED_NOW), '2026-11')
})

test('summarizeLedger computes today, month, series and the DeepSeek slice', () => {
  const summary = summarizeLedger(LEDGER_DOC, FIXED_NOW)
  equal(summary.available, true)
  equal(summary.today.cost, 1.75)
  equal(summary.today.calls, 11)
  equal(summary.month.cost, 9.5)
  equal(summary.month.calls, 23)
  equal(summary.deepseek.today.cost, 1.25)
  equal(summary.deepseek.month.cost, 5)
  equal(summary.series.length, 7)
  equal(summary.series[0].date, '2026-11-05')
  equal(summary.series[6].date, '2026-11-11')
  equal(summary.series[6].cost, 1.75)
  equal(summary.deepseek.series[6].cost, 1.25)
  equal(summary.series[4].cost, 0, 'a quiet day is a zero, not an error')
  equal(summary.providers[0].name, 'deepseek-account')
  equal(summary.providers[0].providerName, 'DeepSeek')
  equal(summary.models.length, 3)
  equal(summary.models.find((entry) => entry.model === 'deepseek-v4-pro').cost, 2.25)
})

test('summarizeLedger treats a missing document as unavailable, not zero', () => {
  const summary = summarizeLedger(null, FIXED_NOW)
  equal(summary.available, false)
  equal(summary.series.length, 7)
  equal(summary.month.cost, 0)
})

test('readLedger distinguishes missing from unreadable', () => {
  const home = tempHome()
  const missing = readLedger(join(home, 'nope.json'), FIXED_NOW)
  equal(missing.error.code, 'missing')
  equal(missing.updatedAt, null)

  writeLedger(home, { version: 1, days: {} })
  writeFileSync(join(home, 'dsh-usage', 'usage-ledger.json'), '{not json')
  const broken = readLedger(join(home, 'dsh-usage', 'usage-ledger.json'), FIXED_NOW)
  equal(broken.error.code, 'unreadable')
  equal(broken.available, false)

  writeLedger(home, { version: 1, days: { '2026-11-11': {} } })
  const good = readLedger(join(home, 'dsh-usage', 'usage-ledger.json'), FIXED_NOW)
  equal(good.available, true)
  ok(good.updatedAt > 0)
})

// ── engine ──────────────────────────────────────────────────────────────────

console.log('# engine')

/** A panel bound to a throwaway home with recording doubles. */
function makePanel(home, options = {}) {
  return new UsagePanel({
    logger: quiet,
    dshHome: home,
    fetchImpl: options.fetchImpl ?? failingFetch().impl,
    now: () => FIXED_NOW,
    env: options.env ?? {}
  })
}

test('an unconfigured panel says so and never invents a balance', () => {
  const home = tempHome()
  const panel = makePanel(home)
  const snapshot = panel.snapshot()
  equal(snapshot.deepseek.state, 'unconfigured')
  equal(snapshot.deepseek.source, 'none')
  equal(snapshot.deepseek.balance, null)
  equal(snapshot.settings.hasKey, false)
  equal(snapshot.ledger.state, 'unavailable')
  equal(snapshot.summary.monthCost, null)
  equal(snapshot.summary.live, 0)
  equal(snapshot.summary.unconfigured, 1)
})

test('updateSettings stores the key and only ever returns a mask', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  const result = await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  equal(result.settings.hasKey, true)
  equal(result.settings.maskedKey, 'sk-…5678')
  equal(result.settings.keySource, 'file')
  ok(existsSync(credentialsPath(home)))
  ok(loadCredentials(home).apiKey === 'sk-abcdefgh12345678')
  ok(!JSON.stringify(result.snapshot).includes('sk-abcdefgh12345678'), 'the snapshot must never carry the clear key')
  ok(!JSON.stringify(result.settings).includes('sk-abcdefgh12345678'))
})

test('refresh turns the card live and persists the cache', async () => {
  const home = tempHome()
  const recorder = jsonFetch(BALANCE_DOC)
  const panel = makePanel(home, { fetchImpl: recorder.impl })
  await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  const snapshot = await panel.refresh()
  equal(snapshot.deepseek.state, 'live')
  equal(snapshot.deepseek.source, 'live')
  equal(snapshot.deepseek.balance.total, 110)
  equal(snapshot.deepseek.balance.currency, 'CNY')
  equal(snapshot.lastAttempt.ok, true)
  ok(snapshot.deepseek.fetchedAt > 0)
  ok(existsSync(join(home, 'usage-panel', 'balance-cache.json')))
  equal(loadBalanceCache(home).fingerprint.length, 16)
})

test('a restart serves the cached balance and marks it as cached', async () => {
  const home = tempHome()
  const panel = makePanel(home, { fetchImpl: jsonFetch(BALANCE_DOC).impl })
  await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  await panel.refresh()

  const restarted = makePanel(home)
  const snapshot = restarted.snapshot()
  equal(snapshot.deepseek.state, 'cached')
  equal(snapshot.deepseek.source, 'cache')
  equal(snapshot.deepseek.balance.total, 110)
  equal(snapshot.deepseek.error, null)
})

test('a failed refresh keeps the previous balance and reports the failure', async () => {
  const home = tempHome()
  const good = makePanel(home, { fetchImpl: jsonFetch(BALANCE_DOC).impl })
  await good.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  await good.refresh()

  const failing = makePanel(home, { fetchImpl: jsonFetch({ error: 'nope' }, { status: 401 }).impl })
  const snapshot = await failing.refresh()
  equal(snapshot.deepseek.state, 'cached')
  equal(snapshot.deepseek.source, 'cache')
  equal(snapshot.deepseek.balance.total, 110, 'the last good number is still shown')
  equal(snapshot.deepseek.error.code, 'unauthorized')
  equal(snapshot.summary.cached, 1)
})

test('a failed refresh with no cache is an error state, not a zero balance', async () => {
  const home = tempHome()
  const panel = makePanel(home, { fetchImpl: jsonFetch({ error: 'nope' }, { status: 403 }).impl })
  await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  const snapshot = await panel.refresh()
  equal(snapshot.deepseek.state, 'error')
  equal(snapshot.deepseek.balance, null)
  equal(snapshot.deepseek.error.code, 'forbidden')
})

test('changing the endpoint drops the cached balance', async () => {
  const home = tempHome()
  const panel = makePanel(home, { fetchImpl: jsonFetch(BALANCE_DOC).impl })
  await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  await panel.refresh()
  ok(existsSync(join(home, 'usage-panel', 'balance-cache.json')))
  const result = await panel.updateSettings({ baseUrl: 'https://proxy.example' })
  equal(result.settings.baseUrl, 'https://proxy.example')
  equal(existsSync(join(home, 'usage-panel', 'balance-cache.json')), false)
  equal(result.snapshot.deepseek.state, 'idle')
  equal(result.snapshot.deepseek.balance, null)
})

test('clearKey removes the credential and the cache', async () => {
  const home = tempHome()
  const panel = makePanel(home, { fetchImpl: jsonFetch(BALANCE_DOC).impl })
  await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  await panel.refresh()
  const result = await panel.updateSettings({ clearKey: true })
  equal(result.settings.hasKey, false)
  equal(loadCredentials(home).apiKey, '')
  equal(result.snapshot.deepseek.state, 'unconfigured')
  equal(existsSync(join(home, 'usage-panel', 'balance-cache.json')), false)
})

test('a key from the environment cannot be cleared from the page', async () => {
  const home = tempHome()
  const panel = makePanel(home, { env: { DEEPSEEK_API_KEY: 'sk-env-1234567890' }, fetchImpl: jsonFetch(BALANCE_DOC).impl })
  equal(panel.snapshot().settings.keySource, 'env')
  let caught
  try {
    await panel.updateSettings({ clearKey: true })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'key-from-env')
  equal(caught?.status, 409)
})

test('a configured key with no ledger invents no usage figures', () => {
  const home = tempHome()
  const panel = makePanel(home, { env: { DEEPSEEK_API_KEY: 'sk-env-12345678' } })
  const snapshot = panel.snapshot()
  equal(snapshot.settings.hasKey, true)
  equal(snapshot.deepseek.usage, undefined, 'the balance card carries no spend')
  equal(snapshot.ledger.state, 'unavailable')
  equal(snapshot.summary.monthCost, null)
  deepEqual(snapshot.summary.servicesSpend, [])
})

test('testConnection without a key reports no-key instead of a blank failure', async () => {
  const panel = makePanel(tempHome())
  const result = await panel.testConnection()
  equal(result.ok, false)
  equal(result.error.code, 'no-key')
  equal(result.balance, null)
})

test('testConnection makes a real request and reports latency', async () => {
  const home = tempHome()
  const recorder = jsonFetch(BALANCE_DOC, { delay: 5 })
  const panel = makePanel(home, { fetchImpl: recorder.impl })
  await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  const result = await panel.testConnection()
  equal(result.ok, true)
  equal(result.balance.total, 110)
  ok(result.ms >= 0)
  equal(recorder.calls.count, 1)
})

test('concurrent refreshes collapse into one request', async () => {
  const home = tempHome()
  const recorder = jsonFetch(BALANCE_DOC, { delay: 15 })
  const panel = makePanel(home, { fetchImpl: recorder.impl })
  await panel.updateSettings({ apiKey: 'sk-abcdefgh12345678' })
  const [first, second] = await Promise.all([panel.refresh(), panel.refresh()])
  equal(recorder.calls.count, 1)
  equal(first.deepseek.state, 'live')
  equal(second.deepseek.state, 'live')
})

test('the ledger detail and the cross-service summary read the fixture', () => {
  const home = tempHome()
  writeLedger(home, LEDGER_DOC)
  const panel = makePanel(home, { env: { DEEPSEEK_API_KEY: 'sk-env-12345678' } })
  const snapshot = panel.snapshot()
  equal(snapshot.ledger.state, 'live')
  equal(snapshot.ledger.today.cost, 1.75)
  equal(snapshot.ledger.month.cost, 9.5)
  equal(snapshot.ledger.month.calls, 23)
  equal(snapshot.ledger.series.length, 7)
  equal(snapshot.summary.monthCost, 9.5)
  equal(snapshot.summary.todayCost, 1.75)
  equal(snapshot.summary.services, 1, 'only official-balance cards count as cards')

  // The summary bar is per service, with a human-facing name.
  equal(snapshot.summary.servicesSpend.length, 2)
  const deepseekSpend = snapshot.summary.servicesSpend.find((entry) => entry.name === 'DeepSeek')
  const minimaxSpend = snapshot.summary.servicesSpend.find((entry) => entry.name === 'MiniMax')
  equal(deepseekSpend.monthCost, 5)
  equal(deepseekSpend.monthCalls, 20)
  equal(minimaxSpend.monthCost, 4.5)

  // The folded detail is per model, aggregated across the month.
  equal(snapshot.ledger.models.length, 3)
  const flash = snapshot.ledger.models.find((entry) => entry.model === 'deepseek-flash')
  equal(flash.providerName, 'DeepSeek')
  equal(flash.cost, 2.75)
  equal(flash.calls, 13)
  equal(snapshot.ledger.models.find((entry) => entry.model === 'abab').providerName, 'MiniMax')
})

test('a transient unreadable ledger serves the previous read as cached', () => {
  const home = tempHome()
  writeLedger(home, LEDGER_DOC)
  const panel = makePanel(home)
  const first = panel.snapshot()
  equal(first.ledger.state, 'live')
  writeFileSync(join(home, 'dsh-usage', 'usage-ledger.json'), '{broken')
  const second = panel.snapshot()
  equal(second.ledger.state, 'cached')
  equal(second.ledger.stale, true)
  equal(second.ledger.month.cost, 9.5)
  ok(second.ledger.error !== null)
})

// ── routes ──────────────────────────────────────────────────────────────────

console.log('# routes')

/** Build a request readable by the route handler. */
function fakeRequest(options = {}) {
  const body = options.rawBody !== undefined
    ? options.rawBody
    : options.body === undefined
      ? ''
      : JSON.stringify(options.body)
  const request = Readable.from(body === '' ? [] : [Buffer.from(body)])
  request.method = options.method ?? 'POST'
  request.url = options.url ?? `${ROUTE_PREFIX}/snapshot`
  request.headers = { host: '127.0.0.1:19387', ...(options.headers ?? {}) }
  request.socket = { remoteAddress: options.remote ?? '127.0.0.1' }
  return request
}

/** A response double that records what the handler wrote. */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
      this.writableEnded = true
    }
  }
}

/** Mount the Host half on a throwaway home and return the route handler. */
function mount(home) {
  const handlers = []
  const ctx = {
    logger: quiet,
    effect(fn) {
      // Run the effect body, but keep its disposer: the route tests exercise the
      // live engine, so an immediate dispose would make every refresh a no-op.
      fn()
    },
    webServer: {
      register(options) {
        handlers.push(options)
        return () => {}
      }
    }
  }
  apply(ctx, { dshHome: home })
  equal(handlers.length, 1)
  return handlers[0]
}

/** Run one request through a mounted handler. */
async function call(handler, options = {}) {
  const response = fakeResponse()
  await handler.handler(fakeRequest(options), response)
  let json
  try {
    json = JSON.parse(response.body)
  } catch {
    json = undefined
  }
  return { response, json }
}

test('the route fence rejects a non-loopback peer', async () => {
  const handler = mount(tempHome())
  const { response } = await call(handler, { remote: '10.0.0.8' })
  equal(response.status, 403)
})

test('the route fence rejects a cross-site origin', async () => {
  const handler = mount(tempHome())
  const { response } = await call(handler, { headers: { origin: 'https://evil.example' } })
  equal(response.status, 403)
})

test('only POST is routed', async () => {
  const handler = mount(tempHome())
  const { response } = await call(handler, { method: 'GET' })
  equal(response.status, 405)
})

test('an unknown method is a 404', async () => {
  const handler = mount(tempHome())
  const { response } = await call(handler, { url: `${ROUTE_PREFIX}/nope` })
  equal(response.status, 404)
})

test('snapshot answers with a complete page payload', async () => {
  const home = tempHome()
  writeLedger(home, LEDGER_DOC)
  const handler = mount(home)
  const { response, json } = await call(handler)
  equal(response.status, 200)
  equal(json.ok, true)
  equal(json.snapshot.deepseek.state, 'unconfigured')
  equal(json.snapshot.ledger.month.cost, 9.5)
  equal(response.headers['cache-control'], 'no-store')
})

test('settings.update saves the key and answers with a mask only', async () => {
  const handler = mount(tempHome())
  const { response, json } = await call(handler, {
    url: `${ROUTE_PREFIX}/settings.update`,
    body: { apiKey: 'sk-abcdefgh12345678' }
  })
  equal(response.status, 200)
  equal(json.ok, true)
  equal(json.settings.maskedKey, 'sk-…5678')
  ok(!response.body.includes('sk-abcdefgh12345678'))
})

test('an invalid key is a 400, not a 500', async () => {
  const handler = mount(tempHome())
  const { response, json } = await call(handler, {
    url: `${ROUTE_PREFIX}/settings.update`,
    body: { apiKey: 'has a space' }
  })
  equal(response.status, 400)
  equal(json.error.code, 'invalid-key')
})

test('a broken JSON body is a 400', async () => {
  const handler = mount(tempHome())
  const { response, json } = await call(handler, {
    rawBody: '{not json'
  })
  equal(response.status, 400)
  equal(json.error.code, 'bad-json')
})

test('refresh reports the provider failure without failing the route', async () => {
  const home = tempHome()
  await saveCredentials(home, 'sk-abcdefgh12345678')
  // A closed loopback port fails fast and deterministically, unlike the real API.
  await saveSettings(home, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000, currency: 'CNY' })
  const handler = mount(home)
  const { response, json } = await call(handler, { url: `${ROUTE_PREFIX}/refresh` })
  equal(response.status, 200)
  equal(json.snapshot.deepseek.state, 'error')
  equal(json.snapshot.deepseek.error.code, 'network')
})

await run('host')
