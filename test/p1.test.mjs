/**
 * P1 offline suite: MiniMax quota, Aliyun balance/signing, session statistics,
 * per-service credentials and the three-provider integration.
 *
 * No network and no real keys: every provider call is answered by a recorder,
 * and every session log is a fixture generated in a throwaway DSH home.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { deepEqual, equal, ok, run, test } from './harness.mjs'
import {
  credentialsPath,
  loadCredentialStore,
  maskAccessKeyId,
  normalizeAliyunEndpoint,
  normalizeMinimaxRegion
} from '../lib/config.js'
import { buildRpcQuery, fetchAliyunBalance, normalizeAliyunBalance, DEFAULT_ENDPOINT } from '../lib/providers/aliyun.js'
import { fetchMinimaxQuota, normalizeMinimaxQuota } from '../lib/providers/minimax.js'
import { isPeakInstant, usageCost } from '../lib/pricing.js'
import { decompressFrames, scanSessions, summarizeSessionBuffer } from '../lib/sessions.js'
import { UsagePanel } from '../lib/index.js'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

/** Nov 11 2026, local noon: the fixed clock for every test. */
const FIXED_NOW = new Date(2026, 10, 11, 12, 0, 0)

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-usage-p1-'))
}

/** A recorded fetch returning one JSON body. */
function jsonFetch(document, options = {}) {
  const status = options.status ?? 200
  const calls = { count: 0, urls: [], headers: [] }
  const impl = async (url, init) => {
    calls.count += 1
    calls.urls.push(String(url))
    calls.headers.push(init?.headers ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(document)
    }
  }
  return { impl, calls }
}

/** A fetch that never answers but honours AbortSignal. */
function hangingFetch() {
  return async (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}

/** A panel bound to a throwaway home. */
function makePanel(home, options = {}) {
  return new UsagePanel({
    logger: quiet,
    dshHome: home,
    fetchImpl: options.fetchImpl ?? hangingFetch(),
    now: () => FIXED_NOW,
    env: options.env ?? {},
    sessionTtlMs: options.sessionTtlMs
  })
}

/** @returns one card by id. */
function cardOf(snapshot, id) {
  return snapshot.cards.find((card) => card.id === id)
}

// ── MiniMax ─────────────────────────────────────────────────────────────────

console.log('# minimax')

/** One complete Token Plan payload. */
function minimaxPayload(overrides = {}) {
  return {
    base_resp: { status_code: 0, status_msg: 'success' },
    model_remains: [
      {
        model_name: 'general',
        current_interval_total_count: 1000,
        current_interval_usage_count: 380,
        start_time: 1794400000000,
        end_time: 1794403600000,
        current_weekly_total_count: 10000,
        current_weekly_usage_count: 6200,
        weekly_end_time: 1794998000000,
        current_subscribe_title: 'Plus'
      }
    ],
    ...overrides
  }
}

test('MM-1 parses counts as used and derives remaining percentages', () => {
  const quota = normalizeMinimaxQuota(minimaxPayload())
  equal(quota.models.length, 1)
  const model = quota.models[0]
  equal(model.name, 'general')
  equal(model.plan, 'Plus')
  equal(model.interval.total, 1000)
  equal(model.interval.used, 380)
  equal(model.interval.remainingPercent, 62)
  equal(model.interval.usedPercent, 38)
  equal(model.weekly.total, 10000)
  equal(model.weekly.used, 6200)
  equal(model.weekly.remainingPercent, 38)
  equal(quota.primary.interval.remainingPercent, 62)
})

test('MM-2 prefers explicit remaining percentages over count arithmetic', () => {
  const payload = minimaxPayload({
    model_remains: [{
      model_name: 'general',
      current_interval_remaining_percent: 73,
      current_weekly_remaining_percent: 51
    }]
  })
  const quota = normalizeMinimaxQuota(payload)
  equal(quota.models[0].interval.remainingPercent, 73)
  equal(quota.models[0].weekly.remainingPercent, 51)
  equal(quota.models[0].interval.total, null)
})

test('MM-3 maps auth, no-plan and empty failures to distinct codes', () => {
  const cases = [
    [{ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }, 'minimax-auth'],
    [{ base_resp: { status_code: 1006, status_msg: 'no subscription plan for this key' } }, 'minimax-no-plan'],
    [{ base_resp: { status_code: 0, status_msg: 'success' }, model_remains: [] }, 'minimax-empty'],
    [null, 'bad-response']
  ]
  for (const [payload, code] of cases) {
    let caught
    try {
      normalizeMinimaxQuota(payload)
    } catch (error) {
      caught = error
    }
    equal(caught?.code, code, `expected ${code}`)
  }
})

test('MM-4 times out at the deadline', async () => {
  let caught
  const started = Date.now()
  try {
    await fetchMinimaxQuota({ apiKey: 'mm-test', region: 'cn', timeoutMs: 40, fetchImpl: hangingFetch() })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'timeout')
  ok(Date.now() - started < 2000)
})

test('MM-5 cn and global regions hit the documented hosts with a Bearer key', async () => {
  const cn = jsonFetch(minimaxPayload())
  await fetchMinimaxQuota({ apiKey: 'mm-secret-key', region: 'cn', timeoutMs: 500, fetchImpl: cn.impl })
  equal(cn.calls.urls[0], 'https://www.minimax.cn/v1/token_plan/remains')
  equal(cn.calls.headers[0].authorization, 'Bearer mm-secret-key')

  const global = jsonFetch(minimaxPayload())
  await fetchMinimaxQuota({ apiKey: 'mm-secret-key', region: 'global', timeoutMs: 500, fetchImpl: global.impl })
  equal(global.calls.urls[0], 'https://www.minimax.io/v1/token_plan/remains')
})

test('MM-6 a rejected key never echoes the key', async () => {
  const recorder = jsonFetch({ base_resp: { status_code: 0 } }, { status: 401 })
  let caught
  try {
    await fetchMinimaxQuota({ apiKey: 'mm-super-secret', region: 'cn', timeoutMs: 500, fetchImpl: recorder.impl })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'minimax-auth')
  ok(!String(caught.message).includes('mm-super-secret'))
})

test('MM-7 zero totals do not produce NaN', () => {
  const quota = normalizeMinimaxQuota({
    base_resp: { status_code: 0 },
    model_remains: [{
      model_name: 'general',
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0
    }]
  })
  equal(quota.models[0].interval.remainingPercent, null)
  ok(!Number.isNaN(quota.models[0].interval.remainingPercent))
})

// ── Aliyun ──────────────────────────────────────────────────────────────────

console.log('# aliyun')

const ALIYUN_VECTOR = {
  accessKeyId: 'EXAMPLE-ACCESS-KEY-0001',
  secret: 'fixture-secret-value',
  nonce: 'fixed-nonce-123',
  timestamp: '2026-11-11T00:00:00Z',
  signature: 'M7sDTyWRJB2/y3GQirQVDXmgoR4=',
  stringToSign: 'GET&%2F&AccessKeyId%3DEXAMPLE-ACCESS-KEY-0001%26Action%3DQueryAccountBalance%26Format%3DJSON%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3Dfixed-nonce-123%26SignatureVersion%3D1.0%26Timestamp%3D2026-11-11T00%253A00%253A00Z%26Version%3D2017-12-14'
}

/** The official QueryAccountBalance success example. */
const ALIYUN_DOC = {
  Code: '200',
  Message: 'success',
  RequestId: '16176743-6DC7-4CB3-BB25-A13982D8DFAD',
  Success: true,
  Data: {
    AvailableAmount: '10000.00',
    CreditAmount: '0.00',
    MybankCreditAmount: '0.00',
    Currency: 'CNY',
    AvailableCashAmount: '10000.00',
    QuotaLimit: '10000.00'
  }
}

test('AL-1 produces the known RPC signature for a fixed request', () => {
  const built = buildRpcQuery({
    accessKeyId: ALIYUN_VECTOR.accessKeyId,
    secret: ALIYUN_VECTOR.secret,
    nonce: ALIYUN_VECTOR.nonce,
    timestamp: ALIYUN_VECTOR.timestamp
  })
  equal(built.stringToSign, ALIYUN_VECTOR.stringToSign)
  equal(built.params.Signature, ALIYUN_VECTOR.signature)
  equal(built.params.Action, 'QueryAccountBalance')
  equal(built.params.Version, '2017-12-14')
  equal(built.params.SignatureMethod, 'HMAC-SHA1')
})

test('AL-2 the request carries the signature but never the secret', async () => {
  const recorder = jsonFetch(ALIYUN_DOC)
  await fetchAliyunBalance({
    accessKeyId: ALIYUN_VECTOR.accessKeyId,
    accessKeySecret: ALIYUN_VECTOR.secret,
    timeoutMs: 500,
    fetchImpl: recorder.impl,
    now: Date.parse('2026-11-11T00:00:00Z'),
    nonce: 'fixed-nonce-123'
  })
  const url = new URL(recorder.calls.urls[0])
  equal(url.protocol, 'https:')
  equal(url.hostname, DEFAULT_ENDPOINT)
  equal(url.searchParams.get('Action'), 'QueryAccountBalance')
  equal(url.searchParams.get('Version'), '2017-12-14')
  equal(url.searchParams.get('Signature'), ALIYUN_VECTOR.signature)
  equal(url.searchParams.get('AccessKeyId'), ALIYUN_VECTOR.accessKeyId)
  ok(!url.search.includes(ALIYUN_VECTOR.secret), 'the secret must not appear in the query')
})

test('AL-3 parses the official success example', () => {
  const balance = normalizeAliyunBalance(ALIYUN_DOC)
  equal(balance.available, 10000)
  equal(balance.cash, 10000)
  equal(balance.credit, 0)
  equal(balance.mybankCredit, 0)
  equal(balance.currency, 'CNY')
})

test('AL-4 maps Aliyun error bodies to stable codes', async () => {
  const cases = [
    [400, { Code: 'InvalidAccessKeyId.NotFound', Message: 'bad id', Success: false }, 'aliyun-auth'],
    [400, { Code: 'SignatureDoesNotMatch', Message: 'bad signature', Success: false }, 'aliyun-signature'],
    [400, { Code: 'NoPermission', Message: 'no permission', Success: false }, 'aliyun-permission'],
    [500, { Code: 'InternalError', Message: 'boom', Success: false }, 'server-error']
  ]
  for (const [status, body, code] of cases) {
    const recorder = jsonFetch(body, { status })
    let caught
    try {
      await fetchAliyunBalance({
        accessKeyId: ALIYUN_VECTOR.accessKeyId,
        accessKeySecret: ALIYUN_VECTOR.secret,
        timeoutMs: 500,
        fetchImpl: recorder.impl
      })
    } catch (error) {
      caught = error
    }
    equal(caught?.code, code)
  }
})

test('AL-5 masks the AccessKey id and never leaks the secret', async () => {
  equal(maskAccessKeyId('EXAMPLE-ACCESS-KEY-0001'), 'EXAM…0001')
  const recorder = jsonFetch(ALIYUN_DOC)
  await fetchAliyunBalance({
    accessKeyId: ALIYUN_VECTOR.accessKeyId,
    accessKeySecret: ALIYUN_VECTOR.secret,
    timeoutMs: 500,
    fetchImpl: recorder.impl
  })
  ok(!recorder.calls.urls[0].includes(ALIYUN_VECTOR.secret))
})

test('AL-6 endpoint normalization falls back to the official host', () => {
  equal(normalizeAliyunEndpoint('https://business.aliyuncs.com/'), 'business.aliyuncs.com')
  equal(normalizeAliyunEndpoint('BUSINESS.ALIYUNCS.COM/path'), 'business.aliyuncs.com')
  equal(normalizeAliyunEndpoint('::::'), DEFAULT_ENDPOINT)
  equal(normalizeAliyunEndpoint(''), DEFAULT_ENDPOINT)
})

test('AL-7 times out at the deadline', async () => {
  let caught
  try {
    await fetchAliyunBalance({
      accessKeyId: ALIYUN_VECTOR.accessKeyId,
      accessKeySecret: ALIYUN_VECTOR.secret,
      timeoutMs: 40,
      fetchImpl: hangingFetch()
    })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'timeout')
})

// ── session statistics ──────────────────────────────────────────────────────

console.log('# sessions')

/** One zstd frame per event, concatenated the way DSH writes them. */
function encodeFrames(events) {
  return Buffer.concat(events.map((event) => zstdCompressSync(Buffer.from(JSON.stringify(event)))))
}

const ALPHA_OFFPEAK = {
  type: 'assistant/message',
  time: Date.parse('2026-11-10T12:00:00Z'),
  data: {
    turn: 1,
    step: 1,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 },
    message: { source: { model: 'deepseek-flash' } }
  }
}
const ALPHA_PEAK = {
  type: 'assistant/message',
  time: Date.parse('2026-11-10T02:00:00Z'),
  data: {
    turn: 1,
    step: 2,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 },
    message: { source: { model: 'deepseek-flash' } }
  }
}
const BETA_MESSAGE = {
  type: 'assistant/message',
  time: Date.parse('2026-11-09T12:00:00Z'),
  data: {
    turn: 1,
    step: 1,
    usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    message: { source: { model: 'deepseek-v4-pro' } }
  }
}

/** Write one session log under the throwaway home. */
function writeSession(home, workspace, id, events) {
  const dir = join(home, 'sessions', workspace, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), encodeFrames(events))
}

/** The standard two-session fixture. */
function writeStandardSessions(home) {
  writeSession(home, 'ws', 'session-alpha', [
    { type: 'session', id: 'session-alpha', cwd: 'C:/work/alpha', createdAt: Date.parse('2026-11-01T00:00:00Z') },
    { type: 'session/title', time: Date.parse('2026-11-01T00:00:00Z'), data: { title: 'Alpha work' } },
    ALPHA_OFFPEAK,
    ALPHA_PEAK
  ])
  writeSession(home, 'ws', 'session-beta', [
    { type: 'session', id: 'session-beta', createdAt: Date.parse('2026-11-02T00:00:00Z') },
    { type: 'session/title', time: Date.parse('2026-11-02T00:00:00Z'), data: { title: 'Beta work' } },
    BETA_MESSAGE
  ])
}

test('SS-1 computes exact per-session cost, calls and tokens', () => {
  const home = tempHome()
  writeStandardSessions(home)
  const result = scanSessions({ root: join(home, 'sessions'), now: FIXED_NOW })
  equal(result.totalSessions, 2)
  equal(result.sessions.length, 2)
  // Alpha costs more: 0.00304 off-peak + 0.00608 peak.
  equal(result.sessions[0].title, 'Alpha work')
  equal(result.sessions[0].calls, 2)
  equal(result.sessions[0].tokens, 7000)
  equal(result.sessions[0].cost, 0.00912)
  equal(result.sessions[1].title, 'Beta work')
  equal(result.sessions[1].calls, 1)
  equal(result.sessions[1].tokens, 200)
  equal(result.sessions[1].cost, 0.0018)
})

test('SS-2 a retry replaces the earlier usage instead of double-counting', () => {
  const home = tempHome()
  const first = {
    ...ALPHA_OFFPEAK,
    data: { ...ALPHA_OFFPEAK.data, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 } }
  }
  const retry = {
    ...ALPHA_OFFPEAK,
    data: { ...ALPHA_OFFPEAK.data, usage: { inputTokens: 1000, outputTokens: 600, cacheReadTokens: 0 } }
  }
  const summary = summarizeSessionBuffer(encodeFrames([
    { type: 'session', id: 'session-retry' },
    first,
    retry
  ]), { monthKey: '2026-11' })
  equal(summary.session.calls, 1)
  // Only the retry is priced: 1000*1 + 600*4 = 3400 / 1e6.
  equal(summary.session.cost, 0.0034)
})

test('SS-3 ignores events outside the current month', () => {
  const home = tempHome()
  writeSession(home, 'ws', 'session-old', [
    { type: 'session', id: 'session-old' },
    {
      ...BETA_MESSAGE,
      time: Date.parse('2026-10-05T12:00:00Z')
    }
  ])
  const result = scanSessions({ root: join(home, 'sessions'), now: FIXED_NOW })
  equal(result.totalSessions, 0)
})

test('SS-4 an unknown model is counted as unpriced, never priced', () => {
  const home = tempHome()
  writeSession(home, 'ws', 'session-unknown', [
    { type: 'session', id: 'session-unknown' },
    {
      ...BETA_MESSAGE,
      data: {
        ...BETA_MESSAGE.data,
        message: { source: { model: 'mystery-model' } }
      }
    }
  ])
  const result = scanSessions({ root: join(home, 'sessions'), now: FIXED_NOW })
  equal(result.sessions[0].cost, 0)
  equal(result.sessions[0].unpricedCalls, 1)
  deepEqual(result.sessions[0].unpricedModels, ['mystery-model'])
})

test('SS-5 corrupt logs are skipped without failing the scan', () => {
  const home = tempHome()
  writeStandardSessions(home)
  const dir = join(home, 'sessions', 'ws', 'session-broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame'))
  const result = scanSessions({ root: join(home, 'sessions'), now: FIXED_NOW })
  equal(result.totalSessions, 2)
  ok(result.skipped >= 1)
})

test('SS-6 the payload contains no message content', () => {
  const home = tempHome()
  writeStandardSessions(home)
  const result = scanSessions({ root: join(home, 'sessions'), now: FIXED_NOW })
  const text = JSON.stringify(result)
  ok(!text.includes('"content"'))
  ok(!text.includes('"prompt"'))
  ok(!text.includes('"text"'))
  ok(!text.includes('C:/work/alpha'), 'workspace paths stay on the Host')
})

test('SS-7 the engine caches the scan for its TTL', async () => {
  const home = tempHome()
  writeStandardSessions(home)
  const panel = makePanel(home, { sessionTtlMs: 30 })
  const first = await panel.sessions()
  equal(first.cached, false)
  equal(first.totalSessions, 2)

  writeSession(home, 'ws', 'session-gamma', [
    { type: 'session', id: 'session-gamma' },
    BETA_MESSAGE
  ])
  const second = await panel.sessions()
  equal(second.cached, true)
  equal(second.totalSessions, 2, 'the TTL result is reused')

  await new Promise((resolveTime) => setTimeout(resolveTime, 40))
  const third = await panel.sessions()
  equal(third.cached, false)
  equal(third.totalSessions, 3)
})

test('SS-8 scanning 50 sessions stays well under two seconds', () => {
  const home = tempHome()
  for (let index = 0; index < 50; index += 1) {
    const events = [{ type: 'session', id: `session-perf-${index}` }]
    for (let step = 1; step <= 10; step += 1) {
      events.push({
        ...BETA_MESSAGE,
        data: { ...BETA_MESSAGE.data, turn: 1, step }
      })
    }
    writeSession(home, 'ws', `session-perf-${index}`, events)
  }
  const started = Date.now()
  const result = scanSessions({ root: join(home, 'sessions'), now: FIXED_NOW })
  const elapsed = Date.now() - started
  equal(result.totalSessions, 50)
  equal(result.sessions.length, 20)
  ok(elapsed < 2000, `scan took ${elapsed}ms`)
})

test('the zstd frame reader handles concatenated frames', () => {
  const buffer = encodeFrames([{ type: 'session', id: 'a' }, { type: 'session/title', data: { title: 'x' } }])
  const result = decompressFrames(buffer)
  equal(result.frames, 2)
  equal(result.skippedFrames, 0)
  ok(result.text.includes('"session"'))
})

test('pricing peaks match the published UTC windows', () => {
  // Tuesday 02:00 UTC = peak; Tuesday 12:00 UTC = off-peak; Saturday = off-peak.
  equal(isPeakInstant(Date.parse('2026-11-10T02:00:00Z')), true)
  equal(isPeakInstant(Date.parse('2026-11-10T12:00:00Z')), false)
  equal(isPeakInstant(Date.parse('2026-11-07T02:00:00Z')), false)
  const offPeak = usageCost('deepseek-flash', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }, Date.parse('2026-11-10T12:00:00Z'))
  const peak = usageCost('deepseek-flash', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }, Date.parse('2026-11-10T02:00:00Z'))
  equal(offPeak.cost, 1)
  equal(peak.cost, 2)
})

// ── credentials / integration ───────────────────────────────────────────────

console.log('# credentials & integration')

test('IN-1 a v1 DeepSeek credential keeps working after the store upgrade', () => {
  const home = tempHome()
  mkdirSync(join(home, 'usage-panel'), { recursive: true })
  writeFileSync(credentialsPath(home), JSON.stringify({
    version: 1,
    deepseek: { apiKey: 'sk-legacy-12345678', updatedAt: 1 }
  }))
  const panel = makePanel(home)
  equal(panel.snapshot().settings.deepseek.hasKey, true)
  equal(loadCredentialStore(home).deepseek.apiKey, 'sk-legacy-12345678')
})

test('IN-2 saving MiniMax does not clobber DeepSeek, and clearing is isolated', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  await panel.updateSettings({ service: 'deepseek', apiKey: 'sk-deepseek-12345678' })
  await panel.updateSettings({ service: 'minimax', apiKey: 'mm-minimax-12345678' })
  let store = loadCredentialStore(home)
  equal(store.deepseek.apiKey, 'sk-deepseek-12345678')
  equal(store.minimax.apiKey, 'mm-minimax-12345678')

  await panel.updateSettings({ service: 'minimax', clear: true })
  store = loadCredentialStore(home)
  equal(store.deepseek.apiKey, 'sk-deepseek-12345678')
  equal(store.minimax.apiKey, '')
})

test('IN-3 Aliyun credentials are stored as a pair and masked', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  const result = await panel.updateSettings({
    service: 'aliyun',
    accessKeyId: 'EXAMPLE-ACCESS-KEY-0001',
    accessKeySecret: 'fixture-secret-value',
    endpoint: 'business.aliyuncs.com'
  })
  equal(result.settings.aliyun.hasKey, true)
  equal(result.settings.aliyun.accessKeyIdMasked, 'EXAM…0001')
  const text = JSON.stringify(result.snapshot)
  ok(!text.includes('fixture-secret-value'))
  ok(!text.includes('EXAMPLE-ACCESS-KEY-0001'))
  equal(loadCredentialStore(home).aliyun.accessKeySecret, 'fixture-secret-value')
})

test('IN-4 one provider failure leaves the other cards untouched', async () => {
  const home = tempHome()
  const panel = makePanel(home)
  await panel.updateSettings({ service: 'deepseek', apiKey: 'sk-deepseek-12345678' })
  await panel.updateSettings({ service: 'minimax', apiKey: 'mm-minimax-12345678' })
  await panel.updateSettings({
    service: 'aliyun',
    accessKeyId: 'EXAMPLE-ACCESS-KEY-0001',
    accessKeySecret: 'fixture-secret-value'
  })
  const recorder = {
    calls: 0,
    impl: async (url) => {
      recorder.calls += 1
      const target = String(url)
      if (target.includes('api.deepseek.com')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }) }
      }
      if (target.includes('minimax')) {
        return { ok: false, status: 401, text: async () => JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid key' } }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(ALIYUN_DOC) }
    }
  }
  panel.fetchImpl = recorder.impl
  const snapshot = await panel.refresh()
  equal(cardOf(snapshot, 'deepseek').state, 'live')
  equal(cardOf(snapshot, 'deepseek').error, null)
  equal(cardOf(snapshot, 'minimax').state, 'error')
  equal(cardOf(snapshot, 'minimax').error.code, 'minimax-auth')
  equal(cardOf(snapshot, 'aliyun').state, 'live')
  equal(cardOf(snapshot, 'aliyun').balance.available, 10000)
})

test('IN-5 unknown services are rejected, not silently mapped to DeepSeek', async () => {
  const panel = makePanel(tempHome())
  let caught
  try {
    await panel.updateSettings({ service: 'nope', apiKey: 'sk-abcdefgh12345678' })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'bad-service')
  equal(caught?.status, 400)
})

console.log('')
await run('p1')


