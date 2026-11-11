/**
 * Browser half for P1: three provider cards, per-service configuration and the
 * lazy session table. The shim renders component trees without a DOM; hooks
 * persist across explicit re-renders so page-level async flows can be tested.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { deepEqual, equal, ok, run, test } from './harness.mjs'

// ── sandbox ─────────────────────────────────────────────────────────────────

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

async function flush(rounds = 8) {
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
      for (const key of ['placeholder', 'title', 'aria-label', 'label', 'value', 'tag', 'body', 'text']) {
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
  timeoutMs: 5000,
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    hasKey: true,
    maskedKey: 'sk-…5678',
    keySource: 'file',
    savedAt: null
  },
  minimax: { region: 'cn', hasKey: true, maskedKey: 'mm-…9b2c', keySource: 'file' },
  aliyun: { endpoint: 'business.aliyuncs.com', hasKey: true, accessKeyIdMasked: 'LTAI…eyId', keySource: 'file' },
  ledgerFile: '~/.dsh/dsh-usage/usage-ledger.json',
  settingsFile: '~/.dsh/usage-panel/settings.json',
  credentialsFile: '~/.dsh/usage-panel/credentials.json'
}

const LEDGER_FILE = '~/.dsh/dsh-usage/usage-ledger.json'

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

function minimaxModel() {
  return {
    name: 'general',
    plan: 'Plus',
    interval: { total: 1000, used: 380, remainingPercent: 62, usedPercent: 38, startAt: 1794400000000, endAt: 1794403600000, remainsAt: null },
    weekly: { total: 10000, used: 6200, remainingPercent: 38, usedPercent: 62, startAt: null, endAt: null, remainsAt: null }
  }
}

function minimaxCard(overrides = {}) {
  const model = minimaxModel()
  return {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'remote',
    state: 'live',
    source: 'live',
    fetchedAt: Date.now(),
    error: null,
    key: { configured: true, masked: 'mm-…9b2c', source: 'file' },
    quota: { plan: 'Plus', models: [model], primary: model },
    ...overrides
  }
}

function aliyunCard(overrides = {}) {
  return {
    id: 'aliyun',
    name: '阿里云',
    kind: 'remote',
    state: 'live',
    source: 'live',
    fetchedAt: Date.now(),
    error: null,
    key: { configured: true, masked: 'LTAI…eyId', source: 'file' },
    balance: {
      available: 10000,
      cash: 10000,
      credit: 0,
      mybankCredit: 0,
      quotaLimit: 10000,
      currency: 'CNY'
    },
    requestId: 'req-1',
    ...overrides
  }
}

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
      { provider: 'minimax', providerName: 'MiniMax', model: 'abab', cost: 20, calls: 800, tokens: 1 }
    ],
    updatedAt: Date.now(),
    stale: false,
    error: null,
    file: LEDGER_FILE,
    ...overrides
  }
}

function sessionData(overrides = {}) {
  return {
    monthKey: '2026-11',
    sessions: [
      { id: 'session-a', title: 'Alpha work', calls: 2, tokens: 7000, cost: 0.00912, unpricedCalls: 0, unpricedModels: [], lastAt: Date.now() }
    ],
    totalSessions: 1,
    scanned: 3,
    skipped: 0,
    durationMs: 12,
    pricing: { label: 'DeepSeek 官方标价（CNY，2026-10-08 版）' },
    cached: false,
    ageMs: 0,
    ...overrides
  }
}

function snapshotFixture(overrides = {}) {
  const deepseek = overrides.deepseek ?? deepseekCard()
  const minimax = overrides.minimax ?? minimaxCard()
  const aliyun = overrides.aliyun ?? aliyunCard()
  const ledger = overrides.ledger ?? ledgerCard()
  return {
    generatedAt: Date.now(),
    cards: [deepseek, minimax, aliyun],
    ledger,
    summary: {
      services: 3,
      live: 3,
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
    lastAttempts: { deepseek: { at: Date.now(), ok: true, ms: 120, error: null }, minimax: null, aliyun: null },
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
  deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'a missing translation would render a raw key')
  ok(Object.keys(zh).length > 90)
})

test('every static t() key in the bundle exists in the dictionaries', () => {
  const requested = [...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)].map((match) => match[1])
  const missing = [...new Set(requested)].filter((key) => zh[key] === undefined)
  deepEqual(missing, [], 'these keys would render as raw identifiers')
  ok(requested.length > 60)
})

test('apply registers the sidebar entry and the main panel it opens', () => {
  resetHooks()
  const registrations = []
  let pendingKey = ''
  const ctx = {
    locale: { bind: () => (key) => zh[key] ?? key, register: () => () => {} },
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
    effect(fn) { fn() }
  }
  exports.apply(ctx)
  const byKey = Object.fromEntries(registrations.map((entry) => [entry.key, entry]))
  deepEqual(Object.keys(byKey).sort(), ['main', 'sidebar.panellist'])
  equal(byKey.main.options.key, 'usage')
  equal(byKey.main.component, internals.UsagePage)
  equal(byKey['sidebar.panellist'].options.id, 'usage')
  equal(byKey['sidebar.panellist'].options.order, 20)
  equal(byKey['sidebar.panellist'].options.label(), '用量')
})

test('the icon renders an svg at the requested size', () => {
  const icon = render(internals.UsageIcon, { size: 22 })
  equal(icon.type, 'svg')
  equal(icon.props.width, 22)
})

// ── formatting ──────────────────────────────────────────────────────────────

console.log('# formatting')

test('money formats currencies; moneyFine keeps small session costs readable', () => {
  equal(internals.money(110), '¥110.00')
  equal(internals.money(1234.5), '¥1,234.50')
  equal(internals.money('12.3', 'USD'), '$12.30')
  equal(internals.moneyFine(0.00912), '¥0.0091')
})

test('describeError maps the P1 provider codes', () => {
  equal(internals.describeError({ code: 'minimax-no-plan' }, t), '该 Key 没有可查询的订阅额度（可能是按量 Key）')
  equal(internals.describeError({ code: 'aliyun-signature' }, t), '阿里云签名校验失败（检查 Secret）')
  equal(internals.describeError({ code: 'mystery', message: 'boom' }, t), 'boom')
})

// ── provider cards ──────────────────────────────────────────────────────────

console.log('# provider cards')

test('DeepSeek keeps its official-balance-only card', () => {
  const tree = render(internals.DeepSeekCard, {
    card: deepseekCard(), t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('¥110.00'), text)
  ok(text.includes('赠金'), text)
  ok(text.includes('sk-…5678'), text)
  ok(text.includes('实时'), text)
  ok(text.includes('测试连接'), text)
  ok(!text.includes('估算'), text)
})

test('an unconfigured MiniMax card explains the subscription/PAYG split', () => {
  const tree = render(internals.MinimaxCard, {
    card: minimaxCard({
      state: 'unconfigured', source: 'none', quota: null,
      key: { configured: false, masked: '', source: 'none' }, fetchedAt: null
    }),
    t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('未配置 MiniMax Key'), text)
  ok(text.includes('按量 Key 没有公开的余额接口'), text)
  ok(!text.includes('%'), 'no invented percentage')
})

test('a live MiniMax card shows both windows, plan and reset', () => {
  const tree = render(internals.MinimaxCard, {
    card: minimaxCard(), t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('62%'), text)
  ok(text.includes('general'), text)
  ok(text.includes('剩余 62% · 周 38%'), text)
  ok(text.includes('Plus'), text)
  ok(text.includes('已用 380 / 1000'), text)
  ok(text.includes('重置'), text)
  equal(find(tree, (element) => element.type === internals.CardFooter).props.card.key.masked, 'mm-…9b2c')
})

test('a MiniMax no-plan key gets a specific explanation, not a generic failure', () => {
  const tree = render(internals.MinimaxCard, {
    card: minimaxCard({
      state: 'error', source: 'none', quota: null, fetchedAt: null,
      error: { code: 'minimax-no-plan', message: 'no plan' }
    }),
    t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('这个 Key 不能查询订阅额度'), text)
  ok(!text.includes('NaN'), text)
})

test('an unconfigured Aliyun card points at the RAM sub-account', () => {
  const tree = render(internals.AliyunCard, {
    card: aliyunCard({
      state: 'unconfigured', source: 'none', balance: null,
      key: { configured: false, masked: '', source: 'none' }, fetchedAt: null
    }),
    t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('未配置阿里云 AccessKey'), text)
  ok(text.includes('RAM 子账号'), text)
  ok(!text.includes('¥0.00'), text)
})

test('a live Aliyun card shows the official balance breakdown', () => {
  const tree = render(internals.AliyunCard, {
    card: aliyunCard(), t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('¥10,000.00'), text)
  ok(text.includes('现金余额'), text)
  ok(text.includes('信控额度'), text)
  equal(find(tree, (element) => element.type === internals.CardFooter).props.card.key.masked, 'LTAI…eyId')
  ok(text.includes('bss:DescribeAcccount'), text)
})

test('an Aliyun signature failure is translated, not raw', () => {
  const tree = render(internals.AliyunCard, {
    card: aliyunCard({
      state: 'error', source: 'none', balance: null, fetchedAt: null,
      error: { code: 'aliyun-signature', message: 'SignatureDoesNotMatch' }
    }),
    t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  ok(treeText(tree).includes('阿里云签名校验失败'), treeText(tree))
})

// ── summary + ledger detail ─────────────────────────────────────────────────

console.log('# summary & ledger')

test('the spend strip still carries the month total and per-service spend', () => {
  const text = treeText(render(internals.SpendSummary, { snapshot: snapshotFixture(), t }))
  ok(text.includes('本月合计（账本口径）'), text)
  ok(text.includes('¥128.40'), text)
  ok(text.includes('DeepSeek'), text)
  ok(text.includes('MiniMax'), text)
})

test('the ledger detail starts collapsed', () => {
  const tree = render(internals.LedgerDetails, {
    snapshot: snapshotFixture(),
    t,
    open: false,
    onToggle() {},
    sessions: { phase: 'idle', data: null, error: null },
    onLoadSessions() {}
  })
  const text = treeText(tree)
  ok(text.includes('账本明细'), text)
  ok(!text.includes('按模型'), text)
  ok(!text.includes('按会话'), text)
})

test('expanded detail includes the trend, models and the session table host', () => {
  const tree = render(internals.LedgerDetails, {
    snapshot: snapshotFixture(),
    t,
    open: true,
    onToggle() {},
    sessions: { phase: 'ready', data: sessionData(), error: null },
    onLoadSessions() {}
  })
  const text = treeText(tree)
  ok(text.includes('近 7 天'), text)
  ok(text.includes('按模型'), text)
  ok(text.includes('按会话'), text)
  ok(find(tree, (element) => element.type === internals.SessionTable) !== undefined)
})

test('the session table renders title, calls and four-decimal cost', () => {
  const tree = render(internals.SessionTable, {
    state: { phase: 'ready', data: sessionData(), error: null },
    t,
    onLoad() {}
  })
  const text = treeText(tree)
  ok(text.includes('Alpha work'), text)
  ok(text.includes('2'), text)
  ok(text.includes('¥0.0091'), text)
  ok(text.includes('按内置价表估算'), text)
  ok(text.includes('扫描 3 个日志'), text)
})

test('the session table has loading, empty and error states', () => {
  const loading = treeText(render(internals.SessionTable, { state: { phase: 'loading' }, t, onLoad() {} }))
  ok(loading.includes('正在扫描会话日志'), loading)
  const empty = treeText(render(internals.SessionTable, {
    state: { phase: 'ready', data: sessionData({ sessions: [], totalSessions: 0 }), error: null },
    t,
    onLoad() {}
  }))
  ok(empty.includes('本月还没有可统计的会话'), empty)
  const error = treeText(render(internals.SessionTable, {
    state: { phase: 'error', data: null, error: { code: 'route-unreachable' } },
    t,
    onLoad() {}
  }))
  ok(error.includes('会话统计加载失败'), error)
  ok(error.includes('重新扫描'), error)
})

// ── configuration ───────────────────────────────────────────────────────────

console.log('# configuration')

test('the config panel has one tab per service and starts on the requested one', () => {
  resetHooks()
  const tree = render(internals.ConfigPanel, {
    settings: SETTINGS,
    initialService: 'aliyun',
    t,
    onSave: async () => {},
    onClear: async () => {},
    onClose() {}
  })
  const tabs = findAll(tree, (element) => element.props?.className === 'dsu-tab')
  equal(tabs.length, 3)
  equal(tabs[0].props['aria-selected'], 'false')
  equal(tabs[2].props['aria-selected'], 'true')
  const form = find(tree, (element) => element.type === internals.ServiceForm)
  equal(form.props.service, 'aliyun')
})

test('the service form posts only its own fields', async () => {
  resetHooks()
  const saved = []
  const tree = render(internals.ServiceForm, {
    service: 'minimax',
    settings: SETTINGS,
    t,
    onSave: async (service, patch) => { saved.push([service, patch]) },
    onClear: async () => {}
  })
  const button = find(tree, (element) => element.type === 'button' && treeText(element).includes('保存'))
  await button.props.onClick()
  await flush(2)
  equal(saved.length, 1)
  equal(saved[0][0], 'minimax')
  equal(saved[0][1].region, 'cn')
  equal(saved[0][1].apiKey, '')
})

test('the Aliyun form has id, secret and endpoint fields', () => {
  resetHooks()
  const tree = render(internals.ServiceForm, {
    service: 'aliyun',
    settings: SETTINGS,
    t,
    onSave: async () => {},
    onClear: async () => {}
  })
  const inputs = findAll(tree, (element) => element.type === 'input')
  equal(inputs.length, 3)
  ok(inputs[0].props.placeholder.includes('LTAI…eyId'), inputs[0].props.placeholder)
  equal(inputs[1].props.type, 'password')
})

// ── page ────────────────────────────────────────────────────────────────────

console.log('# page')

test('the page paints skeleton, then three cards and a collapsed detail', async () => {
  resetHooks()
  const asked = []
  context.fetch = async (url) => {
    asked.push(String(url))
    return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: snapshotFixture() }) }
  }
  const loading = render(internals.UsagePage, { t })
  ok(treeText(loading).includes('服务余额与用量'), treeText(loading))
  ok(find(loading, (element) => element.type === internals.SkeletonCards) !== undefined)

  await flush()
  const ready = render(internals.UsagePage, { t })
  ok(find(ready, (element) => element.type === internals.DeepSeekCard) !== undefined)
  ok(find(ready, (element) => element.type === internals.MinimaxCard) !== undefined)
  ok(find(ready, (element) => element.type === internals.AliyunCard) !== undefined)
  const details = find(ready, (element) => element.type === internals.LedgerDetails)
  equal(details.props.open, false, 'the detail starts collapsed')
  equal(asked.length, 1, 'all cards are live, so no background refresh')
  equal(asked[0], '/usage-panel/api/snapshot')
})

test('a cached configured card triggers one background refresh of the page', async () => {
  resetHooks()
  const asked = []
  const cached = snapshotFixture({ deepseek: deepseekCard({ state: 'cached', source: 'cache' }) })
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

test('opening the config panel from a card targets that service', async () => {
  resetHooks()
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, snapshot: snapshotFixture() }) })
  render(internals.UsagePage, { t })
  await flush()
  let ready = render(internals.UsagePage, { t })
  const minimax = find(ready, (element) => element.type === internals.MinimaxCard)
  minimax.props.onConfigure()
  ready = render(internals.UsagePage, { t })
  const panel = find(ready, (element) => element.type === internals.ConfigPanel)
  ok(panel !== undefined, 'the config panel opens')
  equal(panel.props.initialService, 'minimax')
})

test('opening the detail loads session statistics lazily', async () => {
  resetHooks()
  const asked = []
  context.fetch = async (url) => {
    asked.push(String(url))
    if (String(url).endsWith('/sessions')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions: sessionData() }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, snapshot: snapshotFixture() }) }
  }
  render(internals.UsagePage, { t })
  await flush()
  let ready = render(internals.UsagePage, { t })
  let details = find(ready, (element) => element.type === internals.LedgerDetails)
  details.props.onToggle()
  await flush()
  ready = render(internals.UsagePage, { t })
  details = find(ready, (element) => element.type === internals.LedgerDetails)
  equal(details.props.open, true)
  equal(details.props.sessions.phase, 'ready')
  ok(asked.includes('/usage-panel/api/sessions'), JSON.stringify(asked))
})

test('a dead Host route renders the page error with a retry', async () => {
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
