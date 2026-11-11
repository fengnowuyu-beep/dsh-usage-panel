/**
 * P2 offline suite: custom data sources and balance-threshold alerts.
 * No network: every fetch is a recorder; every file goes to a throwaway home.
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deepEqual, equal, ok, run, test } from './harness.mjs'
import { customSourcesPath, loadCustomCache, loadCustomSources, loadSettings } from '../lib/config.js'
import { alertValue, evaluateAlert } from '../lib/alerts.js'
import {
  MAX_CUSTOM_SOURCES,
  fetchCustomSource,
  maskHeaderValue,
  numberFromJson,
  publicCustomSource,
  resolveJsonPath,
  validateCustomUrl,
  validateHeaders
} from '../lib/custom.js'
import { UsagePanel } from '../lib/index.js'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-usage-p2-'))
}

function jsonFetch(document, options = {}) {
  const status = options.status ?? 200
  const calls = { count: 0, urls: [], headers: [], methods: [] }
  const impl = async (url, init) => {
    calls.count += 1
    calls.urls.push(String(url))
    calls.headers.push(init?.headers ?? {})
    calls.methods.push(init?.method ?? 'GET')
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof document === 'string' ? document : JSON.stringify(document))
    }
  }
  return { impl, calls }
}

function hangingFetch() {
  return async (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}

function makePanel(home, options = {}) {
  return new UsagePanel({
    logger: quiet,
    dshHome: home,
    fetchImpl: options.fetchImpl ?? hangingFetch(),
    now: () => new Date(2026, 10, 11, 12, 0, 0),
    env: options.env ?? {}
  })
}

/** A valid custom source body. */
function source(overrides = {}) {
  return {
    name: 'Example balance',
    url: 'https://example.com/balance',
    valuePath: 'data.balance',
    currency: 'CNY',
    headers: [{ name: 'Authorization', value: 'Bearer fixture-token' }],
    ...overrides
  }
}

// ── path / value parsing ────────────────────────────────────────────────────

console.log('# paths')

test('CD-1 resolves dotted and indexed JSON paths', () => {
  const body = { data: { balance: '12.50' }, items: [{ amount: 3 }, { amount: 4 }] }
  equal(resolveJsonPath(body, 'data.balance'), '12.50')
  equal(resolveJsonPath(body, 'items[1].amount'), 4)
  equal(resolveJsonPath(body, 'missing.path'), undefined)
  equal(resolveJsonPath(body, 'items[9].amount'), undefined)
})

test('numbers accept grouping/currency strings and reject junk', () => {
  equal(numberFromJson('1,234.50'), 1234.5)
  equal(numberFromJson('¥12.00'), 12)
  equal(numberFromJson(7), 7)
  equal(numberFromJson('abc'), null)
  equal(numberFromJson(null), null)
})

// ── validation ──────────────────────────────────────────────────────────────

console.log('# validation')

test('CD-2 URL validation stays inside http(s)', () => {
  equal(validateCustomUrl('https://example.com/a').ok, true)
  equal(validateCustomUrl('http://127.0.0.1:8080/a').ok, true)
  equal(validateCustomUrl('file:///etc/passwd').code, 'invalid-custom-url')
  equal(validateCustomUrl('javascript:alert(1)').code, 'invalid-custom-url')
  equal(validateCustomUrl('data:text/plain,x').code, 'invalid-custom-url')
  equal(validateCustomUrl('https://user:pass@example.com/').code, 'invalid-custom-url')
  equal(validateCustomUrl('').code, 'invalid-custom-url')
})

test('CD-3 header validation rejects CRLF, reserved names and junk', () => {
  equal(validateHeaders([{ name: 'Authorization', value: 'Bearer x' }]).ok, true)
  equal(validateHeaders([{ name: 'X-Bad', value: 'a\r\nb' }]).code, 'invalid-custom-header')
  equal(validateHeaders([{ name: 'Host', value: 'x' }]).code, 'invalid-custom-header')
  equal(validateHeaders([{ name: 'bad name', value: 'x' }]).code, 'invalid-custom-header')
  equal(validateHeaders('nope').code, 'invalid-custom-header')
})

test('header masks keep only the tail, never the value', () => {
  equal(maskHeaderValue('Bearer fixture-token'), '…oken')
  equal(maskHeaderValue('short'), '••••')
  const pub = publicCustomSource({
    id: 'custom-1234abcd',
    name: 'x',
    url: 'https://example.com',
    valuePath: 'a',
    currency: 'CNY',
    headers: [{ name: 'Authorization', value: 'Bearer secret' }]
  })
  ok(!JSON.stringify(pub).includes('Bearer secret'))
})

// ── fetching ────────────────────────────────────────────────────────────────

console.log('# fetching')

test('CD-4 fetches with the exact headers and extracts the number', async () => {
  const recorder = jsonFetch({ data: { balance: '1,234.50' } })
  const result = await fetchCustomSource(
    { ...source(), headers: [{ name: 'Authorization', value: 'Bearer abc' }, { name: 'X-Tenant', value: 't1' }] },
    { timeoutMs: 500, fetchImpl: recorder.impl }
  )
  equal(result.data.value, 1234.5)
  equal(result.data.currency, 'CNY')
  equal(recorder.calls.headers[0].Authorization, 'Bearer abc')
  equal(recorder.calls.headers[0]['X-Tenant'], 't1')
})

test('CD-4 maps auth, HTTP, path, value and timeout failures', async () => {
  const cases = [
    [{ status: 401 }, 'custom-auth'],
    [{ status: 500 }, 'server-error'],
    [{ body: { data: {} } }, 'custom-path'],
    [{ body: { data: { balance: 'not-a-number' } } }, 'custom-value'],
    [{ body: 'not json' }, 'bad-response']
  ]
  for (const [fixture, code] of cases) {
    const recorder = jsonFetch(fixture.body ?? { error: 'x' }, { status: fixture.status ?? 200 })
    let caught
    try {
      await fetchCustomSource(source(), { timeoutMs: 500, fetchImpl: recorder.impl })
    } catch (error) {
      caught = error
    }
    equal(caught?.code, code, `expected ${code}`)
  }

  let timedOut
  try {
    await fetchCustomSource(source(), { timeoutMs: 40, fetchImpl: hangingFetch() })
  } catch (error) {
    timedOut = error
  }
  equal(timedOut?.code, 'timeout')
})

// ── engine: save / refresh / delete ─────────────────────────────────────────

console.log('# engine')

test('CD-5 saves, refreshes and deletes a custom source without leaking headers', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  const saved = await panel.saveCustomSource(source())
  ok(existsSync(customSourcesPath(home)))
  const id = saved.source.id
  ok(/^custom-[0-9a-f]{8}$/.test(id))
  equal(saved.snapshot.cards.some((card) => card.id === id), true)
  equal(saved.settings.customSources.length, 1)
  equal(saved.settings.customSources[0].headers[0].masked, '…oken')
  ok(!JSON.stringify(saved.snapshot).includes('Bearer fixture-token'))
  ok(!JSON.stringify(saved.settings).includes('Bearer fixture-token'))

  const recorder = jsonFetch({ data: { balance: '55.50' } })
  panel.fetchImpl = recorder.impl
  const refreshed = await panel.refresh(id)
  const card = refreshed.cards.find((entry) => entry.id === id)
  equal(card.state, 'live')
  equal(card.balance.value, 55.5)
  equal(card.balance.currency, 'CNY')

  const deleted = await panel.deleteCustomSource(id)
  equal(deleted.snapshot.cards.some((entry) => entry.id === id), false)
  equal(loadCustomSources(home).length, 0)
  equal(loadCustomCache(home)[id], undefined)
})

test('CD-5 caps custom sources at eight', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  for (let index = 0; index < MAX_CUSTOM_SOURCES; index += 1) {
    await panel.saveCustomSource(source({ name: `Source ${index}` }))
  }
  let caught
  try {
    await panel.saveCustomSource(source({ name: 'One too many' }))
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'custom-limit')
  equal(caught?.status, 409)
})

test('CD-5 editing a source clears its cache and preserves headers when omitted', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  const saved = await panel.saveCustomSource(source())
  const id = saved.source.id
  panel.fetchImpl = jsonFetch({ data: { balance: '10' } }).impl
  await panel.refresh(id)
  ok(loadCustomCache(home)[id] !== undefined)

  const edited = await panel.saveCustomSource({ id, name: 'Renamed', url: 'https://example.com/v2', valuePath: 'data.balance' })
  equal(edited.source.name, 'Renamed')
  equal(loadCustomSources(home)[0].headers[0].value, 'Bearer fixture-token', 'omitted headers are preserved')
  equal(loadCustomCache(home)[id], undefined)
})

test('CD-6 one custom failure does not touch the built-in card', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  await panel.updateSettings({ service: 'deepseek', apiKey: 'sk-abcdefgh12345678' })
  const saved = await panel.saveCustomSource(source())
  const id = saved.source.id
  panel.fetchImpl = async (url) => {
    if (String(url).includes('api.deepseek.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] })
      }
    }
    return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'no' }) }
  }
  const snapshot = await panel.refresh()
  const deepseek = snapshot.cards.find((card) => card.id === 'deepseek')
  const custom = snapshot.cards.find((card) => card.id === id)
  equal(deepseek.state, 'live')
  equal(custom.state, 'error')
  equal(custom.error.code, 'custom-auth')
})

test('CD-7 a custom cache is served when the next refresh fails', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  const saved = await panel.saveCustomSource(source())
  const id = saved.source.id
  panel.fetchImpl = jsonFetch({ data: { balance: '20' } }).impl
  await panel.refresh(id)
  panel.fetchImpl = jsonFetch({ error: 'down' }, { status: 500 }).impl
  const snapshot = await panel.refresh(id)
  const card = snapshot.cards.find((entry) => entry.id === id)
  equal(card.state, 'cached')
  equal(card.balance.value, 20)
  equal(card.error.code, 'server-error')
})

// ── alerts ──────────────────────────────────────────────────────────────────

console.log('# alerts')

test('ALRT-1 thresholds are strict, off at zero and gated by enabled', () => {
  const card = { id: 'deepseek', balance: { total: 100 } }
  equal(evaluateAlert(card, { enabled: true, thresholds: { deepseek: 100 } }), null)
  deepEqual(evaluateAlert(card, { enabled: true, thresholds: { deepseek: 101 } }), { threshold: 101, value: 100 })
  equal(evaluateAlert(card, { enabled: true, thresholds: {} }), null)
  equal(evaluateAlert(card, { enabled: true, thresholds: { deepseek: 0 } }), null)
  equal(evaluateAlert(card, { enabled: false, thresholds: { deepseek: 101 } }), null)
})

test('ALRT-2 reads the right metric for each card kind', () => {
  equal(alertValue({ id: 'deepseek', balance: { total: 12 } }), 12)
  equal(alertValue({ id: 'minimax', quota: { primary: { interval: { remainingPercent: 62 } } } }), 62)
  equal(alertValue({ id: 'aliyun', balance: { available: 10000 } }), 10000)
  equal(alertValue({ id: 'custom-1234abcd', balance: { value: 3 } }), 3)
  equal(alertValue({ id: 'deepseek', balance: null }), null)
  equal(evaluateAlert({ id: 'deepseek', balance: null }, { enabled: true, thresholds: { deepseek: 10 } }), null)
})

test('ALRT-3 snapshot carries alert limits and persists them', async () => {
  const home = tempHome()
  const panel = makePanel(home, { env: { DEEPSEEK_API_KEY: 'sk-abcdefgh12345678' } })
  panel.fetchImpl = jsonFetch({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '40.00', granted_balance: '0', topped_up_balance: '40.00' }]
  }).impl
  await panel.refresh('deepseek')
  await panel.updateAlerts({ enabled: true, desktop: false, thresholds: { deepseek: 50 } })
  let snapshot = panel.snapshot()
  let card = snapshot.cards.find((entry) => entry.id === 'deepseek')
  deepEqual(card.alert, { threshold: 50, value: 40 })

  await panel.updateAlerts({ thresholds: { deepseek: 20 } })
  snapshot = panel.snapshot()
  card = snapshot.cards.find((entry) => entry.id === 'deepseek')
  equal(card.alert, null)
  equal(loadSettings(home).alerts.thresholds.deepseek, 20)
})

test('ALRT-3 custom source alerts use the extracted value', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  const saved = await panel.saveCustomSource(source())
  const id = saved.source.id
  panel.fetchImpl = jsonFetch({ data: { balance: '5' } }).impl
  await panel.refresh(id)
  await panel.updateAlerts({ thresholds: { [id]: 10 } })
  const card = panel.snapshot().cards.find((entry) => entry.id === id)
  deepEqual(card.alert, { threshold: 10, value: 5 })
})

test('ALRT-6 rejects unknown targets and negative thresholds', async () => {
  const panel = makePanel(tempHome())
  const cases = [
    { thresholds: { nope: 1 } },
    { thresholds: { deepseek: -1 } },
    { thresholds: { deepseek: 'abc' } }
  ]
  for (const patch of cases) {
    let caught
    try {
      await panel.updateAlerts(patch)
    } catch (error) {
      caught = error
    }
    equal(caught?.code, 'invalid-threshold')
  }
})

console.log('')
await run('p2')
