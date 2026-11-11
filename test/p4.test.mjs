/**
 * P4: MiniMax PAYG balance support.
 * No network; the test fetch answers by URL so the two-stage probe is visible.
 */
import { deepEqual, equal, ok, run, test } from './harness.mjs'
import { UsagePanel } from '../lib/index.js'
import {
  MINIMAX_API_BASES,
  fetchMinimaxAccount,
  normalizeMinimaxBalance
} from '../lib/providers/minimax.js'

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function planPayload() {
  return {
    base_resp: { status_code: 0, status_msg: '' },
    model_remains: [
      {
        model_name: 'general',
        current_subscribe_title: 'Plus',
        current_interval_total_count: 1000,
        current_interval_usage_count: 380,
        current_interval_remaining_percent: 62,
        current_interval_end_time: 1794403600,
        current_weekly_total_count: 10000,
        current_weekly_usage_count: 6200,
        current_weekly_remaining_percent: 38
      }
    ]
  }
}

function balancePayload(amount = '8.88', currency = 'CNY') {
  return { base_resp: { status_code: 0, status_msg: '' }, balance: amount, currency }
}

function routedFetch(routes) {
  const calls = []
  const impl = async (url) => {
    const text = String(url)
    calls.push(text)
    for (const [needle, answer] of routes) {
      if (text.includes(needle)) {
        const status = answer.status ?? 200
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body))
        }
      }
    }
    throw new Error(`unexpected URL ${text}`)
  }
  return { impl, calls }
}

// ── parser ──────────────────────────────────────────────────────────────────

console.log('# PAYG balance parser')

test('P4-1 accepts numeric and string balances and defaults the currency', () => {
  deepEqual(normalizeMinimaxBalance(balancePayload('12.34'), 'cn'), { amount: 12.34, currency: 'CNY' })
  deepEqual(normalizeMinimaxBalance({ balance: 1.5, currency: 'USD' }, 'cn'), { amount: 1.5, currency: 'USD' })
  deepEqual(normalizeMinimaxBalance({ data: { balance: 2 } }, 'global'), { amount: 2, currency: 'USD' })
})

test('P4-1 rejects missing/zero-shaped payloads and base_resp errors', () => {
  let caught
  try { normalizeMinimaxBalance({ base_resp: { status_code: 0 } }, 'cn') } catch (error) { caught = error }
  equal(caught?.code, 'minimax-balance-missing')

  caught = undefined
  try { normalizeMinimaxBalance({ base_resp: { status_code: 1004, status_msg: 'not authorized' } }, 'cn') } catch (error) { caught = error }
  equal(caught?.code, 'minimax-auth')
})

// ── two-stage probe ─────────────────────────────────────────────────────────

test('P4-2 a working Token Plan key never calls the balance endpoint', async () => {
  const recorder = routedFetch([['/v1/token_plan/remains', { body: planPayload() }]])
  const result = await fetchMinimaxAccount({ apiKey: 'sk-plan', region: 'cn', timeoutMs: 500, fetchImpl: recorder.impl })
  equal(result.kind, 'plan')
  equal(result.quota.plan, 'Plus')
  equal(recorder.calls.length, 1)
  equal(recorder.calls[0].includes('/v1/token_plan/remains'), true)
})

test('P4-3 a no-plan key falls back to the PAYG balance on the API host', async () => {
  const recorder = routedFetch([
    ['/v1/token_plan/remains', { body: { base_resp: { status_code: 2062, status_msg: 'no active token plan' } } }],
    ['/account/query_balance', { body: balancePayload('8.88') }]
  ])
  const result = await fetchMinimaxAccount({ apiKey: 'sk-payg', region: 'cn', timeoutMs: 500, fetchImpl: recorder.impl })
  equal(result.kind, 'payg')
  deepEqual(result.balance, { amount: 8.88, currency: 'CNY' })
  equal(recorder.calls.length, 2)
  ok(recorder.calls[1].startsWith(`${MINIMAX_API_BASES.cn}/account/query_balance`), recorder.calls[1])
})

test('P4-3 an auth rejection from token_plan also falls back to balance', async () => {
  const recorder = routedFetch([
    ['/v1/token_plan/remains', { body: { base_resp: { status_code: 1004, status_msg: 'not authorized' } } }],
    ['/account/query_balance', { body: balancePayload('1.25', 'USD') }]
  ])
  const result = await fetchMinimaxAccount({ apiKey: 'sk-payg', region: 'global', timeoutMs: 500, fetchImpl: recorder.impl })
  equal(result.kind, 'payg')
  deepEqual(result.balance, { amount: 1.25, currency: 'USD' })
  ok(recorder.calls[1].startsWith(`${MINIMAX_API_BASES.global}/account/query_balance`), recorder.calls[1])
})

test('P4-4 both endpoints failing surfaces the balance error', async () => {
  const recorder = routedFetch([
    ['/v1/token_plan/remains', { body: { base_resp: { status_code: 2062, status_msg: 'no active token plan' } } }],
    ['/account/query_balance', { body: { base_resp: { status_code: 1004, status_msg: 'not authorized' } } }]
  ])
  let caught
  try {
    await fetchMinimaxAccount({ apiKey: 'sk-bad', region: 'cn', timeoutMs: 500, fetchImpl: recorder.impl })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'minimax-auth')
  equal(recorder.calls.length, 2)
})

test('P4-4 a transport failure does not trigger the balance fallback', async () => {
  const recorder = routedFetch([['/v1/token_plan/remains', { status: 500, body: { error: 'down' } }]])
  let caught
  try {
    await fetchMinimaxAccount({ apiKey: 'sk-any', region: 'cn', timeoutMs: 500, fetchImpl: recorder.impl })
  } catch (error) {
    caught = error
  }
  equal(caught?.code, 'server-error')
  equal(recorder.calls.length, 1)
})

// ── engine ──────────────────────────────────────────────────────────────────

console.log('# engine')

function makePanel(fetchImpl) {
  return new UsagePanel({
    logger: quiet,
    dshHome: process.env.TEMP + '\\dsh-p4-' + Math.random().toString(16).slice(2),
    fetchImpl,
    now: () => new Date(2026, 10, 12, 0, 30, 0),
    env: {}
  })
}

test('P4-5 a PAYG key becomes card.payg with an amount and no percentage', async () => {
  const recorder = routedFetch([
    ['/v1/token_plan/remains', { body: { base_resp: { status_code: 2062, status_msg: 'no active token plan' } } }],
    ['/account/query_balance', { body: balancePayload('8.88') }]
  ])
  const panel = makePanel(recorder.impl)
  await panel.updateSettings({ service: 'minimax', apiKey: 'sk-payg-1234567890' })
  const snapshot = await panel.refresh('minimax')
  const card = snapshot.cards.find((entry) => entry.id === 'minimax')
  equal(card.state, 'live')
  equal(card.quota, null)
  deepEqual(card.payg, { amount: 8.88, currency: 'CNY' })
  equal(card.keys[0].remainingPercent, null)
  deepEqual(card.keys[0].balance, { amount: 8.88, currency: 'CNY' })
  equal(card.alert, null)
})

test('P4-6 a PAYG balance can breach an amount threshold', async () => {
  const recorder = routedFetch([
    ['/v1/token_plan/remains', { body: { base_resp: { status_code: 2062, status_msg: 'no active token plan' } } }],
    ['/account/query_balance', { body: balancePayload('8.88') }]
  ])
  const panel = makePanel(recorder.impl)
  await panel.updateSettings({ service: 'minimax', apiKey: 'sk-payg-1234567890' })
  await panel.refresh('minimax')
  await panel.updateAlerts({ thresholds: { minimax: 20 } })
  const card = panel.snapshot().cards.find((entry) => entry.id === 'minimax')
  deepEqual(card.alert, { threshold: 20, value: 8.88 })
})

console.log('')
await run('p4')
