/**
 * P3 offline suite: additional keys and CSV export.
 * No network; every fetch is a recorder, every file a throwaway home.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { deepEqual, equal, ok, run, test } from './harness.mjs'
import {
  addExtraKey,
  credentialsPath,
  emptyCredentialStore,
  loadCredentialStore,
  loadExtraKeys,
  saveCredentialStore
} from '../lib/config.js'
import { buildExport, csvDocument, csvEscape, exportBalances, exportLedger, exportSessions } from '../lib/csv.js'
import { UsagePanel, apply, ROUTE_PREFIX } from '../lib/index.js'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-usage-p3-'))
}

function makePanel(home, fetchImpl) {
  return new UsagePanel({
    logger: quiet,
    dshHome: home,
    fetchImpl: fetchImpl ?? (async () => { throw new Error('unexpected fetch') }),
    now: () => new Date(2026, 10, 11, 12, 0, 0),
    env: {}
  })
}

function balanceFetch(map) {
  const calls = { keys: [] }
  const impl = async (url, init) => {
    const raw = init?.headers?.authorization ?? init?.headers?.Authorization ?? ''
    const key = String(raw).replace(/^Bearer\s+/, '')
    calls.keys.push(key)
    const value = map[key]
    if (value === undefined) {
      return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'bad key' }) }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: String(value), granted_balance: '0', topped_up_balance: String(value) }]
      })
    }
  }
  return { impl, calls }
}

function withCredentials(home, document) {
  mkdirSync(join(home, 'usage-panel'), { recursive: true })
  writeFileSync(credentialsPath(home), JSON.stringify(document), 'utf8')
}

// ── multi-key ───────────────────────────────────────────────────────────────

console.log('# multi-key')

test('MK-1 a v2 credential file migrates without losing the primary key', async () => {
  const home = tempHome()
  withCredentials(home, {
    version: 2,
    deepseek: { apiKey: 'sk-abcdefgh12345678', updatedAt: 1 },
    minimax: { apiKey: 'mm-abcdefgh12345678' },
    aliyun: { accessKeyId: 'EXAMPLE-ACCESS-KEY-0001', accessKeySecret: 'fixture-secret-value' }
  })
  const store = loadCredentialStore(home)
  equal(store.version, 3)
  equal(store.deepseek.apiKey, 'sk-abcdefgh12345678')
  deepEqual(store.deepseek.extraKeys, [])
  equal(store.aliyun.accessKeyId, 'EXAMPLE-ACCESS-KEY-0001')

  const added = await addExtraKey(home, 'deepseek', { label: '备用', apiKey: 'sk-extraone1234567890' })
  equal(added.ok, true)
  const reloaded = loadCredentialStore(home)
  equal(reloaded.deepseek.apiKey, 'sk-abcdefgh12345678')
  equal(reloaded.deepseek.extraKeys.length, 1)
  equal(reloaded.deepseek.extraKeys[0].label, '备用')
})

test('MK-2 adds at most three extra keys and validates labels/secrets', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  await panel.updateSettings({ service: 'deepseek', apiKey: 'sk-primary1234567890ab' })
  const labels = ['备用一', '备用二', '备用三']
  for (const [index, label] of labels.entries()) {
    const result = await panel.addKey('deepseek', { label, apiKey: `sk-extra${index}1234567890` })
    equal(result.settings.deepseek.extraKeys.length, index + 1)
  }
  let caught
  try {
    await panel.addKey('deepseek', { label: '太多', apiKey: 'sk-extra41234567890' })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'key-limit')
  equal(caught?.status, 409)

  caught = undefined
  try {
    await panel.addKey('deepseek', { label: '', apiKey: 'sk-extra51234567890' })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'invalid-key-label')

  const id = loadExtraKeys(home, 'deepseek')[0].id
  await panel.deleteKey('deepseek', id)
  equal(loadExtraKeys(home, 'deepseek').length, 2)
  equal(loadCredentialStore(home).deepseek.apiKey, 'sk-primary1234567890ab', 'deleting an extra key keeps the primary')
})

test('MK-3 masks appear in settings/snapshot, plaintext only in the private file', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  await panel.updateSettings({ service: 'deepseek', apiKey: 'sk-primary1234567890ab' })
  await panel.addKey('deepseek', { label: '备用', apiKey: 'sk-extra-secret-fixture' })
  const snapshot = panel.snapshot()
  const publicSettings = snapshot.settings
  const extra = publicSettings.deepseek.extraKeys[0]
  equal(extra.masked.startsWith('sk-'), true)
  ok(!JSON.stringify(snapshot).includes('sk-extra-secret-fixture'))
  ok(!JSON.stringify(publicSettings).includes('sk-extra-secret-fixture'))
  const raw = readFileSync(credentialsPath(home), 'utf8')
  ok(raw.includes('sk-extra-secret-fixture'), 'the private file may hold the secret')
})

test('MK-4 two keys are queried separately and keep different values', async () => {
  const home = tempHome()
  const primary = 'sk-primary1234567890ab'
  const extra = 'sk-extraone1234567890'
  const recorder = balanceFetch({ [primary]: 110, [extra]: 220 })
  const panel = makePanel(home, recorder.impl)
  await panel.updateSettings({ service: 'deepseek', apiKey: primary })
  await panel.addKey('deepseek', { label: '备用', apiKey: extra })
  const snapshot = await panel.refresh('deepseek')
  const card = snapshot.cards.find((entry) => entry.id === 'deepseek')
  equal(card.balance.total, 110)
  equal(card.keys.length, 2)
  equal(card.keys[0].label, '主 Key')
  equal(card.keys[0].balance.total, 110)
  equal(card.keys[1].label, '备用')
  equal(card.keys[1].balance.total, 220)
  deepEqual(recorder.calls.keys.sort(), [primary, extra].sort())
})

test('MK-5 one extra key failing does not break the primary or its sibling', async () => {
  const home = tempHome()
  const primary = 'sk-primary1234567890ab'
  const extra1 = 'sk-extraone1234567890'
  const extra2 = 'sk-extratwo1234567890'
  const panel = makePanel(home, balanceFetch({ [primary]: 110, [extra2]: 50 }).impl)
  await panel.updateSettings({ service: 'deepseek', apiKey: primary })
  await panel.addKey('deepseek', { label: '坏 Key', apiKey: extra1 })
  await panel.addKey('deepseek', { label: '好 Key', apiKey: extra2 })
  const snapshot = await panel.refresh('deepseek')
  const card = snapshot.cards.find((entry) => entry.id === 'deepseek')
  equal(card.state, 'live')
  equal(card.keys[1].state, 'error')
  equal(card.keys[1].balance, null)
  equal(card.keys[2].state, 'live')
  equal(card.keys[2].balance.total, 50)
})

test('MK-6 an extra-key cache survives a restart', async () => {
  const home = tempHome()
  const primary = 'sk-primary1234567890ab'
  const extra = 'sk-extraone1234567890'
  const panel = makePanel(home, balanceFetch({ [primary]: 110, [extra]: 50 }).impl)
  await panel.updateSettings({ service: 'deepseek', apiKey: primary })
  await panel.addKey('deepseek', { label: '备用', apiKey: extra })
  await panel.refresh('deepseek')

  const restarted = makePanel(home)
  const card = restarted.snapshot().cards.find((entry) => entry.id === 'deepseek')
  equal(card.keys[1].balance.total, 50)
  equal(card.keys[1].state, 'cached')
})

test('MK-7 refreshing one key does not probe the primary', async () => {
  const home = tempHome()
  const primary = 'sk-primary1234567890ab'
  const extra = 'sk-extraone1234567890'
  const recorder = balanceFetch({ [primary]: 110, [extra]: 50 })
  const panel = makePanel(home, recorder.impl)
  await panel.updateSettings({ service: 'deepseek', apiKey: primary })
  await panel.addKey('deepseek', { label: '备用', apiKey: extra })
  await panel.refresh('deepseek')
  const before = recorder.calls.keys.filter((key) => key === primary).length
  const id = loadExtraKeys(home, 'deepseek')[0].id
  await panel.refresh('deepseek', id)
  equal(recorder.calls.keys.filter((key) => key === primary).length, before)
  equal(recorder.calls.keys.filter((key) => key === extra).length, 2)
})

// ── CSV ─────────────────────────────────────────────────────────────────────

console.log('# csv')

test('CSV-1 documents start with BOM and use CRLF', () => {
  const text = csvDocument(['a', 'b'], [[1, 2]])
  equal(text.charCodeAt(0), 0xFEFF)
  ok(text.includes('\r\n'))
  ok(!/(?<!\r)\n/.test(text))
  equal(text, '\uFEFFa,b\r\n1,2\r\n')
})

test('CSV-2 escapes commas, quotes and newlines', () => {
  equal(csvEscape('a,b'), '"a,b"')
  equal(csvEscape('a"b'), '"a""b"')
  equal(csvEscape('a\nb'), '"a\nb"')
  equal(csvEscape('中文'), '中文')
  equal(csvEscape(null), '')
})

/** A tiny RFC4180 parser for round-trip checks. */
function parseCsv(text) {
  const body = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' && body[index + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

test('CSV-3 balances export includes each key mask, never the secret', () => {
  const snapshot = {
    cards: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'remote',
        state: 'live',
        source: 'live',
        alert: { threshold: 200, value: 110 },
        keys: [
          { id: 'primary', label: '主 Key', masked: 'sk-…5678', state: 'live', source: 'live', fetchedAt: 1, balance: { total: 110, currency: 'CNY' }, remainingPercent: null },
          { id: 'key-1', label: '备用', masked: 'sk-…9abc', state: 'error', source: 'none', fetchedAt: null, balance: null, remainingPercent: null }
        ]
      },
      {
        id: 'custom-abcd1234',
        name: '示例',
        kind: 'custom',
        state: 'live',
        source: 'live',
        fetchedAt: null,
        balance: { value: 55.5, currency: 'CNY' },
        alert: null
      }
    ]
  }
  const rows = parseCsv(exportBalances(snapshot))
  equal(rows.length, 4)
  equal(rows[1][0], 'DeepSeek')
  equal(rows[1][2], 'sk-…5678')
  equal(rows[1][4], '110')
  equal(rows[1][7], 'true')
  equal(rows[2][2], 'sk-…9abc')
  equal(rows[3][0], '示例')
  ok(!JSON.stringify(rows).includes('sk-primary'))
})

test('CSV-4 ledger export has daily and model rows', () => {
  const snapshot = {
    ledger: {
      state: 'live',
      series: [{ date: '2026-11-10', cost: 1.25 }, { date: '2026-11-11', cost: 2.5 }],
      models: [{ providerName: 'DeepSeek', model: 'v4-pro', calls: 3, tokens: 900, cost: 2.5 }]
    }
  }
  const rows = parseCsv(exportLedger(snapshot))
  equal(rows[0][0], 'kind')
  equal(rows[1][0], 'daily')
  equal(rows[1][1], '2026-11-10')
  equal(rows[3][0], 'model')
  equal(rows[3][2], 'DeepSeek')
  equal(rows[3][6], '2.5')
})

test('CSV-5 session titles with commas and quotes round-trip', () => {
  const sessions = {
    monthKey: '2026-11',
    sessions: [{ id: 'session-a', title: 'a,"b"', calls: 2, tokens: 7000, cost: 0.00912, unpricedCalls: 1, lastAt: 1 }]
  }
  const rows = parseCsv(exportSessions(sessions))
  equal(rows[1][2], 'a,"b"')
  equal(rows[1][4], '7000')
  equal(rows[1][6], '1')
})

test('CSV-7 empty ledgers/sessions still emit the header row', () => {
  const ledger = parseCsv(exportLedger({ ledger: { state: 'unavailable' } }))
  equal(ledger.length, 1)
  const sessions = parseCsv(exportSessions({ monthKey: '2026-11', sessions: [] }))
  equal(sessions.length, 1)
})

test('CSV-8 buildExport names files and rejects unknown scopes', () => {
  const built = buildExport('balances', { cards: [] }, new Date('2026-11-11T00:00:00Z'))
  equal(built.filename, 'usage-panel-balances-20261111.csv')
  equal(buildExport('nope', {}), null)
  deepEqual(emptyCredentialStore().version, 3)
})

// ── export route ────────────────────────────────────────────────────────────

console.log('# export route')

function fakeRequest(options = {}) {
  const body = options.body === undefined ? '' : JSON.stringify(options.body)
  const request = Readable.from(body === '' ? [] : [Buffer.from(body)])
  request.method = options.method ?? 'POST'
  request.url = options.url ?? `${ROUTE_PREFIX}/snapshot`
  request.headers = { host: '127.0.0.1:19387', ...(options.headers ?? {}) }
  request.socket = { remoteAddress: options.remote ?? '127.0.0.1' }
  return request
}

function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body ?? ''; this.writableEnded = true }
  }
}

function mount(home) {
  const handlers = []
  const ctx = {
    logger: quiet,
    effect(fn) { fn() },
    webServer: { register(options) { handlers.push(options); return () => {} } }
  }
  apply(ctx, { dshHome: home })
  equal(handlers.length, 1)
  return handlers[0]
}

test('CSV-6 the export route returns an attachment with BOM', async () => {
  const handler = mount(tempHome())
  const response = fakeResponse()
  await handler.handler(fakeRequest({ method: 'GET', url: `${ROUTE_PREFIX}/export?scope=balances` }), response)
  equal(response.status, 200)
  ok(String(response.headers['content-type']).startsWith('text/csv'))
  ok(String(response.headers['content-disposition']).includes('usage-panel-balances-'))
  equal(response.body.charCodeAt(0), 0xFEFF)
  ok(response.body.includes('service,key_label'))
})

test('CSV-6 an unknown export scope is a 400, not a 500', async () => {
  const handler = mount(tempHome())
  const response = fakeResponse()
  await handler.handler(fakeRequest({ method: 'GET', url: `${ROUTE_PREFIX}/export?scope=nope` }), response)
  equal(response.status, 400)
  equal(JSON.parse(response.body).error.code, 'bad-scope')
})

console.log('')
await run('p3')
