/**
 * Browser half: the P0.1 layout.
 *
 * The page now has three layers — a cross-service spend strip, official-balance
 * cards, and a collapsed ledger detail. These tests pin that separation: spend
 * must not leak back onto the balance card, the detail must start collapsed,
 * and an unavailable ledger must never render invented zeros.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { deepEqual, equal, ok, run, test } from './harness.mjs'

// ── the sandbox ─────────────────────────────────────────────────────────────

function createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props ?? {}),
      ...(children.length === 0 ? {} : children.length === 1 ? { children: children[0] } : { children })
    }
  }
}

let hookSlots = []
let hookCursor = 0

const hooks = {
  useState(initial) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = typeof initial === 'function' ? initial() : initial
    return [hookSlots[index], (next) => {
      hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next
    }]
  },
  useRef(value) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = { current: value }
    return hookSlots[index]
  },
  useEffect(fn) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = fn()
  },
  useCallback(fn) {
    const index = hookCursor++
    if (!(index in hookSlots)) hookSlots[index] = fn
    return hookSlots[index]
  }
}

function render(component, props) {
  hookCursor = 0
  return component(props)
}

function resetHooks() {
  hookSlots = []
  hookCursor = 0
}

async function flush(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

const reactShim = {
  default: {
    createElement,
    useState: hooks.useState,
    useRef: hooks.useRef,
    useEffect: hooks.useEffect,
    useCallback: hooks.useCallback
  }
}

const fakeDocument = {
  head: { appendChild() {} },
  querySelector() { return null },
  createElement() { return { dataset: {}, style: {}, textContent: '' } }
}

const context = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout,
  clearTimeout,
  document: fakeDocument,
  window: { __ModuleLoader__: { load: (definition) => { context.__definition = definition } } },
  fetch: async () => { throw new Error('no network in tests') }
}
context.globalThis = context
vm.createContext(context)

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInContext(source, context, { filename: 'lib/client.js' })

const definition = context.__definition
ok(definition !== undefined, 'the module must register itself with the loader')
equal(definition.id, 'dsh-usage-panel')

const exports = definition.factory((id) => {
  if (id === 'react') return reactShim
  throw new Error(`unexpected require("${id}")`)
})
const internals = exports.__internals
const zh = internals.zh
const en = internals.en
const t = (key, params) => internals.interpolate(zh[key] ?? key, params)

// ── tree helpers ────────────────────────────────────────────────────────────

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'object' && node.props !== undefined) {
    visit(node)
    walk(node.props.children, visit)
  }
}

function treeText(node) {
  const parts = []
  const collect = (value) => {
    if (value === null || value === undefined) return
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) collect(child)
      return
    }
    if (typeof value === 'object' && value.props !== undefined) {
      for (const key of ['placeholder', 'title', 'aria-label', 'label', 'value', 'tag']) {
        if (typeof value.props[key] === 'string') parts.push(value.props[key])
      }
      collect(value.props.children)
    }
  }
  collect(node)
  return parts.join(' ')
}

function findAll(node, predicate) {
  const found = []
  walk(node, (element) => {
    if (predicate(element)) found.push(element)
  })
  return found
}

function find(node, predicate) {
  return findAll(node, predicate)[0]
}

// ── fixtures ────────────────────────────────────────────────────────────────

const SETTINGS = {
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 5000,
  currency: 'CNY',
  hasKey: true,
  maskedKey: 'sk-…5678',
  keySource: 'file',
  savedAt: 1794399685025,
  ledgerFile: '~/.dsh/dsh-usage/usage-ledger.json',
  settingsFile: '~/.dsh/usage-panel/settings.json',
  credentialsFile: '~/.dsh/usage-panel/credentials.json'
}

const LEDGER_FILE = 'C:/Users/x/.dsh/dsh-usage/usage-ledger.json'

/** A DeepSeek balance card. It no longer carries spend. */
function deepseekCard(overrides = {}) {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'remote',
    state: 'live',
    source: 'live',
    available: true,
    balance: { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
    items: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }],
    fetchedAt: Date.now(),
    error: null,
    key: { configured: true, masked: 'sk-…5678', source: 'file' },
    ...overrides
  }
}

/** The ledger payload: summary numbers, 7-day series, per-model rows. */
function ledgerCard(overrides = {}) {
  return {
    id: 'ledger',
    name: 'DSH 本地账本',
    kind: 'local',
    state: 'live',
    source: 'live',
    today: { cost: 18.42, calls: 1554, tokens: 1000 },
    month: { cost: 128.4, calls: 3120, tokens: 2000 },
    series: [
      { date: '2026-11-05', cost: 1 },
      { date: '2026-11-06', cost: 2 },
      { date: '2026-11-07', cost: 0 },
      { date: '2026-11-08', cost: 3 },
      { date: '2026-11-09', cost: 1.5 },
      { date: '2026-11-10', cost: 2.5 },
      { date: '2026-11-11', cost: 18.42 }
    ],
    models: [
      { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-flash', cost: 100, calls: 2000, tokens: 1 },
      { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-v4-pro', cost: 20, calls: 800, tokens: 1 },
      { provider: 'minimax', providerName: 'MiniMax', model: 'abab', cost: 8.4, calls: 320, tokens: 1 }
    ],
    updatedAt: Date.now(),
    stale: false,
    error: null,
    file: LEDGER_FILE,
    ...overrides
  }
}

/** A whole snapshot for the page and summary tests. */
function snapshotFixture(overrides = {}) {
  const deepseek = overrides.deepseek ?? deepseekCard()
  const ledger = overrides.ledger ?? ledgerCard()
  return {
    generatedAt: Date.now(),
    cards: [deepseek],
    deepseek,
    ledger,
    summary: {
      services: 1,
      live: 1,
      cached: 0,
      unconfigured: 0,
      error: 0,
      idle: 0,
      monthCost: 128.4,
      todayCost: 18.42,
      monthCalls: 3120,
      ledgerState: 'live',
      ledgerUpdatedAt: Date.now(),
      servicesSpend: [
        { id: 'deepseek-account', name: 'DeepSeek', monthCost: 120, monthCalls: 2800, todayCost: 16 },
        { id: 'minimax', name: 'MiniMax', monthCost: 8.4, monthCalls: 320, todayCost: 2.42 }
      ]
    },
    lastAttempt: { at: Date.now(), ok: true, ms: 120, error: null },
    settings: SETTINGS,
    ...overrides
  }
}

// ── module contract ─────────────────────────────────────────────────────────

console.log('# module contract')

test('the browser half declares the services it needs', () => {
  deepEqual(exports.inject, ['slots', 'locale'])
  equal(exports.NS, 'usagePanel')
  equal(exports.PANEL_ID, 'usage')
  equal(typeof exports.apply, 'function')
})

test('both dictionaries carry exactly the same keys', () => {
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  deepEqual(enKeys, zhKeys, 'a missing translation would render a raw key')
  ok(zhKeys.length > 60)
})

test('every static t() key in the bundle exists in the dictionaries', () => {
  const requested = [...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)].map((match) => match[1])
  const missing = [...new Set(requested)].filter((key) => zh[key] === undefined)
  deepEqual(missing, [], 'these keys would render as raw identifiers')
  ok(requested.length > 40)
})

test('apply registers the sidebar entry and the main panel it opens', () => {
  resetHooks()
  const registrations = []
  let pendingKey = ''
  const ctx = {
    locale: {
      bind: () => (key) => zh[key] ?? key,
      register: () => () => {}
    },
    slots: {
      inject(key, callback) {
        pendingKey = key
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ key: pendingKey, options, component })
        return { dispose() {} }
      }
    },
    effect(fn) {
      fn()
    }
  }
  exports.apply(ctx)
  const byKey = Object.fromEntries(registrations.map((entry) => [entry.key, entry]))
  deepEqual(Object.keys(byKey).sort(), ['main', 'sidebar.panellist'])
  equal(byKey.main.options.key, 'usage')
  equal(byKey.main.options.locale, 'usagePanel')
  equal(byKey.main.component, internals.UsagePage)
  equal(byKey['sidebar.panellist'].options.id, 'usage')
  equal(byKey['sidebar.panellist'].options.order, 20)
  equal(byKey['sidebar.panellist'].options.label(), '用量')
})

test('the icon renders an svg at the requested size', () => {
  const icon = render(internals.UsageIcon, { size: 22 })
  equal(icon.type, 'svg')
  equal(icon.props.width, 22)
  equal(icon.props.height, 22)
})

// ── formatting ──────────────────────────────────────────────────────────────

console.log('# formatting')

test('money formats both currencies with tabular grouping', () => {
  equal(internals.money(110), '¥110.00')
  equal(internals.money(1234.5), '¥1,234.50')
  equal(internals.money('12.3', 'USD'), '$12.30')
  equal(internals.money(undefined), '—')
})

test('describeError prefers the stable code over the Host message', () => {
  equal(internals.describeError({ code: 'timeout', message: 'timed out' }, t), '请求超时（5 秒）')
  equal(internals.describeError({ code: 'unauthorized', message: 'nope' }, t), 'Key 无效或已过期')
  equal(internals.describeError({ code: 'mystery', message: 'boom' }, t), 'boom')
  equal(internals.describeError(null, t), '')
})

test('the reader falls back to the local dictionary', () => {
  const fallback = internals.readerOf(undefined)
  equal(fallback('refresh'), '刷新')
  equal(fallback('detailsSummary', { cost: '¥1.00', calls: '3' }), '本月 ¥1.00 · 3 次调用')
})

// ── balance card ────────────────────────────────────────────────────────────

console.log('# balance card')

test('an unconfigured DeepSeek card offers the way in and never shows ¥0.00', () => {
  const tree = render(internals.DeepSeekCard, {
    card: deepseekCard({
      state: 'unconfigured',
      source: 'none',
      balance: null,
      items: [],
      key: { configured: false, masked: '', source: 'none' },
      fetchedAt: null
    }),
    t,
    onConfigure() {},
    onTest() {},
    testing: false,
    testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('未配置 DeepSeek Key'), text)
  ok(text.includes('去配置'), text)
  ok(!text.includes('¥0.00'), 'an absent key is not a zero balance')
  ok(!text.includes('¥110.00'), 'no invented balance')
})

test('a live balance card shows only official figures, never spend', () => {
  const tree = render(internals.DeepSeekCard, {
    card: deepseekCard(),
    t,
    onConfigure() {},
    onTest() {},
    testing: false,
    testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('DeepSeek'), text)
  ok(text.includes('¥110.00'), text)
  ok(text.includes('赠金'), text)
  ok(text.includes('¥10.00'), text)
  ok(text.includes('充值'), text)
  ok(text.includes('sk-…5678'), text)
  ok(text.includes('实时'), text)
  ok(text.includes('测试连接'), text)
  ok(!text.includes('估算'), 'spend does not belong on the balance card')
  ok(!text.includes('¥2.22'), text)
  ok(find(tree, (element) => element.type === internals.TrendChart) === undefined, 'no ledger chart inside the balance card')
})

test('a cached balance card says so and warns that data may be old', () => {
  const tree = render(internals.DeepSeekCard, {
    card: deepseekCard({ state: 'cached', source: 'cache', error: { code: 'timeout', message: 'timed out' } }),
    t,
    onConfigure() {},
    onTest() {},
    testing: false,
    testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('缓存'), text)
  ok(text.includes('上次刷新失败，显示的可能是过期数据'), text)
  ok(text.includes('¥110.00'), 'the last good number stays visible')
})

test('a failed balance card explains the failure instead of a bare zero', () => {
  const tree = render(internals.DeepSeekCard, {
    card: deepseekCard({
      state: 'error',
      source: 'none',
      balance: null,
      items: [],
      available: null,
      fetchedAt: null,
      error: { code: 'unauthorized', message: 'rejected' }
    }),
    t,
    onConfigure() {},
    onTest() {},
    testing: false,
    testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('Key 无效或已过期'), text)
  ok(!text.includes('¥0.00'), text)
})

test('an idle balance card says it is waiting for the first read', () => {
  const tree = render(internals.DeepSeekCard, {
    card: deepseekCard({ state: 'idle', source: 'none', balance: null, items: [], fetchedAt: null, error: null }),
    t,
    onConfigure() {},
    onTest() {},
    testing: false,
    testResult: null
  })
  ok(treeText(tree).includes('等待首次读取'), treeText(tree))
})

test('a successful test result renders latency and balance', () => {
  const tree = render(internals.DeepSeekCard, {
    card: deepseekCard(),
    t,
    onConfigure() {},
    onTest() {},
    testing: false,
    testResult: { ok: true, ms: 320, balance: { currency: 'CNY', total: 110 }, error: null }
  })
  const text = treeText(tree)
  ok(text.includes('连接正常'), text)
  ok(text.includes('320 ms'), text)
  ok(text.includes('¥110.00'), text)
})

// ── spend summary ───────────────────────────────────────────────────────────

console.log('# spend summary')

test('the strip shows the month total and each service, all tagged 估算', () => {
  const tree = render(internals.SpendSummary, { snapshot: snapshotFixture(), t })
  const text = treeText(tree)
  ok(text.includes('本月合计（账本口径）'), text)
  ok(text.includes('¥128.40'), text)
  ok(text.includes('DeepSeek'), text)
  ok(text.includes('¥120.00'), text)
  ok(text.includes('MiniMax'), text)
  ok(text.includes('¥8.40'), text)
  ok(text.includes('账本更新于'), text)
  equal(findAll(tree, (element) => element.props?.className === 'dsu-tag estimate').length, 3, 'total + two services')
})

test('a stale ledger is marked cached in the strip and in the detail', () => {
  const ledger = ledgerCard({ state: 'cached', source: 'cache', stale: true, error: { code: 'unreadable' } })
  const snapshot = snapshotFixture({ ledger })
  const summaryText = treeText(render(internals.SpendSummary, { snapshot, t }))
  ok(summaryText.includes('缓存'), summaryText)
  const detailText = treeText(render(internals.LedgerDetails, { snapshot, t, open: true, onToggle() {} }))
  ok(detailText.includes('本次账本读取失败，显示的是上次结果'), detailText)
})

test('an unavailable ledger is stated plainly, with no zero total', () => {
  const snapshot = snapshotFixture({
    ledger: ledgerCard({ state: 'unavailable', source: 'none', error: { code: 'missing' }, today: { cost: 0, calls: 0 }, month: { cost: 0, calls: 0 }, models: [], series: [] }),
    summary: {
      services: 1,
      live: 1,
      cached: 0,
      unconfigured: 0,
      error: 0,
      idle: 0,
      monthCost: null,
      todayCost: null,
      monthCalls: null,
      ledgerState: 'unavailable',
      ledgerUpdatedAt: null,
      servicesSpend: []
    }
  })
  const text = treeText(render(internals.SpendSummary, { snapshot, t }))
  ok(text.includes('不可用'), text)
  ok(text.includes('账本不可用，无法汇总'), text)
  ok(text.includes('账本文件未找到'), text)
  ok(!text.includes('¥0.00'), text)
})

// ── ledger detail ───────────────────────────────────────────────────────────

console.log('# ledger detail')

test('the detail starts collapsed and only shows its header', () => {
  const tree = render(internals.LedgerDetails, {
    snapshot: snapshotFixture(),
    t,
    open: false,
    onToggle() {}
  })
  const text = treeText(tree)
  ok(text.includes('账本明细'), text)
  ok(text.includes('本月 ¥128.40 · 3,120 次调用'), text)
  ok(text.includes('展开 ▾'), text)
  ok(!text.includes('按模型'), 'the body must stay unmounted while collapsed')
  ok(!text.includes('近 7 天'), text)
})

test('expanded detail shows the trend, per-model rows and the session gap', () => {
  const tree = render(internals.LedgerDetails, {
    snapshot: snapshotFixture(),
    t,
    open: true,
    onToggle() {}
  })
  const text = treeText(tree)
  ok(text.includes('收起 ▴'), text)
  ok(text.includes('近 7 天'), text)
  ok(text.includes('按模型'), text)
  ok(text.includes('按会话'), text)
  ok(text.includes('不含会话维度'), text)
  ok(text.includes('DeepSeek'), text)
  ok(text.includes('deepseek-flash'), text)
  ok(text.includes('¥100.00'), text)
  ok(text.includes('2,000'), text)
  ok(text.includes('MiniMax'), text)
  ok(text.includes(LEDGER_FILE), text)
  ok(find(tree, (element) => element.type === internals.TrendChart) !== undefined, 'the 7-day chart is mounted')
})

test('the trend chart draws seven labelled columns', () => {
  const tree = render(internals.TrendChart, { points: ledgerCard().series, t })
  const columns = findAll(tree, (element) => element.props?.className === 'dsu-trend-col')
  equal(columns.length, 7)
  const text = treeText(tree)
  ok(text.includes('11-11'), text)
  ok(text.includes('¥18.42'), text)
  ok(text.includes('近 7 天'), text)
})

test('an unavailable ledger detail names the file instead of drawing zeros', () => {
  const ledger = ledgerCard({
    state: 'unavailable',
    source: 'none',
    error: { code: 'missing' },
    today: { cost: 0, calls: 0 },
    month: { cost: 0, calls: 0 },
    models: [],
    series: [],
    updatedAt: null
  })
  const tree = render(internals.LedgerDetails, {
    snapshot: snapshotFixture({ ledger }),
    t,
    open: true,
    onToggle() {}
  })
  const text = treeText(tree)
  ok(text.includes('账本不可用'), text)
  ok(text.includes(LEDGER_FILE), text)
  ok(!text.includes('¥0.00'), text)
})

// ── config form ─────────────────────────────────────────────────────────────

console.log('# config form')

test('the form masks the saved key and posts only what was typed', async () => {
  resetHooks()
  const saved = []
  const tree = render(internals.ConfigPanel, {
    settings: SETTINGS,
    t,
    onSave: async (patch) => { saved.push(patch) },
    onClear: async () => {},
    onClose() {}
  })
  const inputs = findAll(tree, (element) => element.type === 'input')
  equal(inputs.length, 2)
  equal(inputs[0].props.type, 'password')
  equal(inputs[0].props.placeholder, '已保存 sk-…5678，留空保持不变')
  const form = find(tree, (element) => element.type === 'form')
  await form.props.onSubmit({ preventDefault() {} })
  await flush(2)
  equal(saved.length, 1)
  equal(saved[0].apiKey, '')
  equal(saved[0].baseUrl, 'https://api.deepseek.com')
})

test('the form reports a save failure in the reader language', async () => {
  resetHooks()
  render(internals.ConfigPanel, {
    settings: SETTINGS,
    t,
    onSave: async () => { throw new internals.ApiError('route-unreachable', 'down') },
    onClear: async () => {},
    onClose() {}
  })
  const form = find(render(internals.ConfigPanel, {
    settings: SETTINGS,
    t,
    onSave: async () => {},
    onClear: async () => {},
    onClose() {}
  }), (element) => element.type === 'form')
  await form.props.onSubmit({ preventDefault() {} })
  await flush(2)
  const rerendered = render(internals.ConfigPanel, {
    settings: SETTINGS,
    t,
    onSave: async () => {},
    onClear: async () => {},
    onClose() {}
  })
  ok(treeText(rerendered).includes('宿主插件路由不可用'), treeText(rerendered))
})

// ── page ────────────────────────────────────────────────────────────────────

console.log('# page')

test('the page paints a skeleton, then summary + balance + collapsed detail', async () => {
  resetHooks()
  const asked = []
  context.fetch = async (url, init) => {
    asked.push({ url: String(url), body: init?.body })
    return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: snapshotFixture() }) }
  }

  const loading = render(internals.UsagePage, { t })
  const loadingText = treeText(loading)
  ok(loadingText.includes('服务余额与用量'), loadingText)
  ok(loadingText.includes('尚未更新'), loadingText)
  ok(find(loading, (element) => element.type === internals.SkeletonCards) !== undefined)

  await flush()
  const ready = render(internals.UsagePage, { t })
  const summary = find(ready, (element) => element.type === internals.SpendSummary)
  const card = find(ready, (element) => element.type === internals.DeepSeekCard)
  const details = find(ready, (element) => element.type === internals.LedgerDetails)
  ok(summary !== undefined, 'the spend strip is mounted')
  ok(card !== undefined, 'the balance card is mounted')
  ok(details !== undefined, 'the ledger detail is mounted')
  equal(details.props.open, false, 'the detail starts collapsed')
  ok(treeText(ready).includes('官方余额 = 还剩多少钱'), treeText(ready))
  equal(asked.length, 1, 'a live snapshot needs no background refresh')
  equal(asked[0].url, '/usage-panel/api/snapshot')
})

test('toggling the detail opens it without a reload', async () => {
  resetHooks()
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, snapshot: snapshotFixture() }) })
  render(internals.UsagePage, { t })
  await flush()
  const ready = render(internals.UsagePage, { t })
  const details = find(ready, (element) => element.type === internals.LedgerDetails)
  details.props.onToggle()
  const reopened = render(internals.UsagePage, { t })
  const afterToggle = find(reopened, (element) => element.type === internals.LedgerDetails)
  equal(afterToggle.props.open, true)
})

test('the page refreshes in the background when the snapshot is only cached', async () => {
  resetHooks()
  const asked = []
  const cached = snapshotFixture({
    deepseek: deepseekCard({ state: 'cached', source: 'cache' }),
    lastAttempt: null
  })
  context.fetch = async (url) => {
    asked.push(String(url))
    if (String(url).endsWith('/snapshot')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: cached }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: snapshotFixture() }) }
  }
  render(internals.UsagePage, { t })
  await flush()
  equal(asked.length, 2)
  equal(asked[1], '/usage-panel/api/refresh')
})

test('a dead Host route renders the page error with a retry, not a blank page', async () => {
  resetHooks()
  context.fetch = async () => { throw new Error('no route') }
  render(internals.UsagePage, { t })
  await flush()
  const text = treeText(render(internals.UsagePage, { t }))
  ok(text.includes('面板加载失败'), text)
  ok(text.includes('宿主插件路由不可用'), text)
  ok(text.includes('重试'), text)
})

console.log('')
await run('client')
