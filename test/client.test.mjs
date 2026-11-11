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
    // Re-render with the newest closure so a form tested after a state change
    // sees the updated values.
    hookCursor += 1
    return fn
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
  alerts: { enabled: true, desktop: false, thresholds: { deepseek: 50 } },
  customSources: [],
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

function customCard(overrides = {}) {
  return {
    id: 'custom-abcd1234',
    name: 'Example balance',
    kind: 'custom',
    state: 'live',
    source: 'live',
    fetchedAt: Date.now(),
    error: null,
    key: { configured: true, masked: '', source: 'file' },
    custom: {
      url: 'https://example.com/balance',
      valuePath: 'data.balance',
      currency: 'CNY',
      headers: [{ name: 'Authorization', masked: '…oken' }]
    },
    balance: { value: 55.5, currency: 'CNY' },
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
  const custom = overrides.custom ?? null
  const ledger = overrides.ledger ?? ledgerCard()
  const cards = [deepseek, minimax, aliyun, ...(custom === null ? [] : [custom])]
  return {
    generatedAt: Date.now(),
    cards,
    ledger,
    summary: {
      services: cards.length,
      live: cards.length,
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
  ok(text.includes('按量 Key 可查账户余额'), text)
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

test('a MiniMax PAYG card shows the account balance, not a percentage', () => {
  const card = minimaxCard({
    state: 'live',
    quota: null,
    payg: { amount: 8.88, currency: 'CNY', cash: 8.88, voucher: 0, credit: 0, owed: 0 },
    keys: [
      { id: 'primary', label: '主 Key', masked: 'sk-…payg', state: 'live', source: 'live', fetchedAt: Date.now(), balance: { amount: 8.88, currency: 'CNY' }, remainingPercent: null },
      { id: 'key-1', label: '备用', masked: 'sk-…back', state: 'live', source: 'live', fetchedAt: Date.now(), balance: { amount: 3.2, currency: 'CNY' }, remainingPercent: null }
    ]
  })
  const tree = render(internals.MinimaxCard, {
    card, t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('¥8.88'), text)
  ok(text.includes('按量余额'), text)
  ok(text.includes('按量计费余额'), text)
  ok(text.includes('现金余额'), text)
  ok(!text.includes('62%'), text)
  const keyRows = treeText(render(internals.KeyRows, { card, t }))
  ok(keyRows.includes('¥3.20'), keyRows)
  const alert = render(internals.AlertLine, { card: { ...card, alert: { threshold: 20, value: 8.88 } }, t })
  ok(treeText(alert).includes('低于阈值：¥20.00（当前 ¥8.88）'), treeText(alert))
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
  equal(tabs.length, 5)
  equal(tabs[0].props['aria-selected'], 'false')
  equal(tabs[2].props['aria-selected'], 'true')
  equal(treeText(tabs[3]), '告警')
  equal(treeText(tabs[4]), '自定义数据源')
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
  equal(inputs.length, 6, 'three primary fields plus three additional-key fields')
  ok(inputs[0].props.placeholder.includes('LTAI…eyId'), inputs[0].props.placeholder)
  equal(inputs[1].props.type, 'password')
})

// ── P2: custom sources & alerts ─────────────────────────────────────────────

console.log('# P2 custom sources & alerts')

test('a custom card shows its value, JSON path, header count and URL', () => {
  const tree = render(internals.CustomCard, {
    card: customCard(), t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  const text = treeText(tree)
  ok(text.includes('¥55.50'), text)
  equal(find(tree, (element) => element.type === internals.CardHead).props.card.name, 'Example balance')
  ok(text.includes('data.balance'), text)
  ok(text.includes('https://example.com/balance'), text)
  equal(tree.props['data-alert'], undefined)
})

test('an alerted card carries the red marker and the threshold sentence', () => {
  const tree = render(internals.CustomCard, {
    card: customCard({ alert: { threshold: 100, value: 55.5 } }),
    t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  equal(tree.props['data-alert'], 'true')
  const alert = render(internals.AlertLine, { card: customCard({ alert: { threshold: 100, value: 55.5 } }), t })
  ok(treeText(alert).includes('低于阈值：¥100.00（当前 ¥55.50）'), treeText(alert))
})

test('the alert threshold form saves only the thresholds that are on', async () => {
  resetHooks()
  let saved
  const settings = {
    ...SETTINGS,
    customSources: [{ id: 'custom-abcd1234', name: 'Example balance', url: 'https://example.com', valuePath: 'data.balance', currency: 'CNY', headers: [] }]
  }
  let tree = render(internals.AlertsForm, {
    settings, t, onSave: async (patch) => { saved = patch }
  })
  const inputs = findAll(tree, (element) => element.type === 'input' && element.props.type === 'number')
  equal(inputs.length, 4, 'three built-ins plus one custom source')
  inputs[0].props.onChange({ target: { value: '60' } })
  tree = render(internals.AlertsForm, { settings, t, onSave: async (patch) => { saved = patch } })
  const save = find(tree, (element) => element.type === 'button' && treeText(element).includes('保存'))
  await save.props.onClick()
  await flush(2)
  deepEqual(saved, { enabled: true, desktop: false, thresholds: { deepseek: 60 } })
})

test('the custom-source editor preserves existing headers when the box is blank', async () => {
  resetHooks()
  let saved
  const existing = {
    id: 'custom-abcd1234',
    name: 'Example balance',
    url: 'https://example.com/balance',
    valuePath: 'data.balance',
    currency: 'CNY',
    headers: [{ name: 'Authorization', masked: '…oken' }]
  }
  const settings = { ...SETTINGS, customSources: [existing] }
  let tree = render(internals.CustomSourcesForm, {
    settings, t, onSave: async (patch) => { saved = patch }, onDelete: async () => {}
  })
  const tab = findAll(tree, (element) => element.props?.className === 'dsu-tab').find((element) => treeText(element) === 'Example balance')
  tab.props.onClick()
  tree = render(internals.CustomSourcesForm, {
    settings, t, onSave: async (patch) => { saved = patch }, onDelete: async () => {}
  })
  ok(treeText(tree).includes('Authorization: …oken'), treeText(tree))
  const save = find(tree, (element) => element.type === 'button' && treeText(element).includes('保存数据源'))
  await save.props.onClick()
  await flush(2)
  equal(saved.id, 'custom-abcd1234')
  equal('headers' in saved, false, 'blank header box keeps the stored ones')
})

test('a new custom source sends parsed header lines', async () => {
  resetHooks()
  let saved
  let tree = render(internals.CustomSourcesForm, {
    settings: { ...SETTINGS, customSources: [] }, t, onSave: async (patch) => { saved = patch }, onDelete: async () => {}
  })
  const inputs = findAll(tree, (element) => element.type === 'input' && element.props.type === 'text')
  const values = ['Example', 'data.balance', 'https://example.com/balance', 'CNY']
  for (const [index, value] of values.entries()) {
    inputs[index].props.onChange({ target: { value } })
  }
  const textarea = find(tree, (element) => element.type === 'textarea')
  textarea.props.onChange({ target: { value: 'Authorization: Bearer abc\nX-Tenant: t1' } })
  tree = render(internals.CustomSourcesForm, {
    settings: { ...SETTINGS, customSources: [] }, t, onSave: async (patch) => { saved = patch }, onDelete: async () => {}
  })
  const save = find(tree, (element) => element.type === 'button' && treeText(element).includes('保存数据源'))
  await save.props.onClick()
  await flush(2)
  equal(saved.name, 'Example')
  deepEqual(saved.headers, [
    { name: 'Authorization', value: 'Bearer abc' },
    { name: 'X-Tenant', value: 't1' }
  ])
})

test('deleting a custom source needs two clicks', async () => {
  resetHooks()
  let deleted
  const existing = {
    id: 'custom-abcd1234', name: 'Example', url: 'https://example.com', valuePath: 'a', currency: 'CNY', headers: []
  }
  const settings = { ...SETTINGS, customSources: [existing] }
  let tree = render(internals.CustomSourcesForm, {
    settings, t, onSave: async () => {}, onDelete: async (id) => { deleted = id }
  })
  findAll(tree, (element) => element.props?.className === 'dsu-tab').find((element) => treeText(element) === 'Example').props.onClick()
  tree = render(internals.CustomSourcesForm, {
    settings, t, onSave: async () => {}, onDelete: async (id) => { deleted = id }
  })
  const danger = find(tree, (element) => element.type === 'button' && element.props?.className === 'dsu-btn danger')
  danger.props.onClick()
  tree = render(internals.CustomSourcesForm, {
    settings, t, onSave: async () => {}, onDelete: async (id) => { deleted = id }
  })
  find(tree, (element) => element.type === 'button' && element.props?.className === 'dsu-btn danger').props.onClick()
  await flush(2)
  equal(deleted, 'custom-abcd1234')
})

test('desktop alerts are sent once per service per day and never include credentials', () => {
  const calls = []
  class FakeNotification {
    constructor(title, options) { calls.push({ title, options }) }
  }
  FakeNotification.permission = 'granted'
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value) }
  }
  const snapshot = snapshotFixture({
    deepseek: deepseekCard({ alert: { threshold: 100, value: 40 } })
  })
  snapshot.settings = { ...snapshot.settings, alerts: { enabled: true, desktop: true, thresholds: { deepseek: 100 } } }
  const options = { NotificationCtor: FakeNotification, storage, now: new Date('2026-11-11T08:00:00Z') }
  equal(internals.notifyAlerts(snapshot, t, options), 1)
  equal(internals.notifyAlerts(snapshot, t, options), 0)
  equal(calls.length, 1)
  ok(calls[0].title.includes('DeepSeek'), calls[0].title)
  ok(calls[0].options.body.includes('40'), calls[0].options.body)
  ok(!JSON.stringify(calls).includes('sk-'), 'no credential leaks')
})

test('desktop alerts respect the switch, permission and missing API', () => {
  const snapshot = snapshotFixture({ deepseek: deepseekCard({ alert: { threshold: 100, value: 40 } }) })
  const enabled = { ...snapshot, settings: { ...snapshot.settings, alerts: { enabled: true, desktop: false, thresholds: { deepseek: 100 } } } }
  class Denied { constructor() {} }
  Denied.permission = 'denied'
  const storage = { getItem: () => null, setItem() {} }
  equal(internals.notifyAlerts(enabled, t, { NotificationCtor: Denied, storage }), 0, 'desktop is off')
  const on = { ...enabled, settings: { ...enabled.settings, alerts: { enabled: true, desktop: true, thresholds: { deepseek: 100 } } } }
  equal(internals.notifyAlerts(on, t, { NotificationCtor: Denied, storage }), 0, 'permission denied')
  equal(internals.notifyAlerts(on, t, { NotificationCtor: undefined, storage }), 0, 'API unavailable')
})

// ── P4: low balance & UI ────────────────────────────────────────────────────

console.log('# low balance UI')

test('lowOf applies the universal 10 threshold to amounts and percentages', () => {
  equal(internals.lowOf(deepseekCard({ balance: { total: 10, currency: 'CNY' } })), null)
  deepEqual(internals.lowOf(deepseekCard({ balance: { total: 9.99, currency: 'CNY' } })), { kind: 'amount', value: 9.99, currency: 'CNY' })
  deepEqual(internals.lowOf(aliyunCard({ balance: { ...aliyunCard().balance, available: 1.48 } })), { kind: 'amount', value: 1.48, currency: 'CNY' })
  deepEqual(internals.lowOf(minimaxCard({ payg: { amount: 8.88, currency: 'CNY' }, quota: null })), { kind: 'amount', value: 8.88, currency: 'CNY' })
  deepEqual(internals.lowOf(minimaxCard({ quota: { ...minimaxCard().quota, primary: { interval: { remainingPercent: 9 } } } })), { kind: 'percent', value: 9 })
  equal(internals.lowOf(minimaxCard({ quota: { ...minimaxCard().quota, primary: { interval: { remainingPercent: 10 } } } })), null)
})

test('a low Aliyun card gets the amber marker and sentence', () => {
  const card = aliyunCard({ balance: { ...aliyunCard().balance, available: 1.48 } })
  const tree = render(internals.AliyunCard, { card, t, onConfigure() {}, onTest() {}, testing: false, testResult: null })
  equal(tree.props['data-low'], 'true')
  const head = treeText(render(internals.CardHead, { card, t }))
  ok(head.includes('余量偏低'), head)
  const low = treeText(render(internals.LowLine, { card, t }))
  ok(low.includes('余量不足 ¥10.00（当前 ¥1.48）'), low)
})

test('a low MiniMax PAYG card keeps the amber marker and alert precedence', () => {
  const card = minimaxCard({
    quota: null,
    payg: { amount: 8.88, currency: 'CNY', cash: 0, voucher: 8.88, credit: 0, owed: 0 },
    keys: [{ id: 'primary', label: '主 Key', masked: 'sk-…payg', state: 'live', source: 'live', fetchedAt: Date.now(), balance: { amount: 8.88, currency: 'CNY' }, remainingPercent: null }]
  })
  const tree = render(internals.MinimaxCard, { card, t, onConfigure() {}, onTest() {}, testing: false, testResult: null })
  equal(tree.props['data-low'], 'true')
  ok(treeText(render(internals.CardHead, { card, t })).includes('余量偏低'))
  ok(treeText(render(internals.LowLine, { card, t })).includes('余量不足 ¥10.00（当前 ¥8.88）'))
  ok(treeText(tree).includes('代金券'), treeText(tree))

  const alerted = { ...card, alert: { threshold: 20, value: 8.88 } }
  const alertedTree = render(internals.MinimaxCard, {
    card: alerted,
    t, onConfigure() {}, onTest() {}, testing: false, testResult: null
  })
  equal(alertedTree.props['data-alert'], 'true')
  equal(render(internals.LowLine, { card: alerted, t }), null)
  const alertLine = render(internals.AlertLine, { card: alerted, t })
  ok(treeText(alertLine).includes('低于阈值：¥20.00（当前 ¥8.88）'), treeText(alertLine))
})

test('a low additional key row is colored, and the page shows a low banner', async () => {
  const card = deepseekCard({
    keys: [
      { id: 'primary', label: '主 Key', masked: 'sk-…5678', state: 'live', source: 'live', fetchedAt: Date.now(), balance: { total: 110, currency: 'CNY' }, remainingPercent: null },
      { id: 'key-1', label: '备用', masked: 'sk-…back', state: 'live', source: 'live', fetchedAt: Date.now(), balance: { total: 3, currency: 'CNY' }, remainingPercent: null }
    ]
  })
  const keyRows = render(internals.KeyRows, { card, t })
  ok(findAll(keyRows, (element) => typeof element.props?.className === 'string' && element.props.className.includes('dsu-key-low')).length >= 1)
})

test('the page shows a low-balance banner with the count', async () => {
  resetHooks()
  const snapshot = snapshotFixture({
    deepseek: deepseekCard({ balance: { total: 9.99, currency: 'CNY' }, items: [] }),
    aliyun: aliyunCard({ balance: { ...aliyunCard().balance, available: 1.48 } })
  })
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, snapshot }) })
  render(internals.UsagePage, { t })
  await flush()
  const text = treeText(render(internals.UsagePage, { t }))
  ok(text.includes('2 个服务余量低于 10'), text)
})

test('KeyRows lists additional keys and hides itself for a single key', () => {
  const card = deepseekCard({
    keys: [
      { id: 'primary', label: '主 Key', masked: 'sk-…5678', state: 'live', source: 'live', fetchedAt: Date.now(), balance: { total: 110, currency: 'CNY' }, remainingPercent: null },
      { id: 'key-1', label: '备用', masked: 'sk-…9abc', state: 'live', source: 'live', fetchedAt: Date.now(), balance: { total: 220, currency: 'CNY' }, remainingPercent: null }
    ]
  })
  const text = treeText(render(internals.KeyRows, { card, t }))
  ok(text.includes('备用'), text)
  ok(text.includes('sk-…9abc'), text)
  ok(text.includes('¥220.00'), text)
  equal(treeText(render(internals.KeyRows, { card: deepseekCard({ keys: card.keys.slice(0, 1) }), t })), '')
})

test('ExportLinks points at the three Host scopes', () => {
  const tree = render(internals.ExportLinks, { t })
  const links = findAll(tree, (element) => element.type === 'a')
  equal(links.length, 3)
  ok(links[0].props.href.endsWith('/export?scope=balances'), links[0].props.href)
  ok(links[1].props.href.endsWith('/export?scope=ledger'))
  ok(links[2].props.href.endsWith('/export?scope=sessions'))
})

test('the service form adds and deletes an additional key', async () => {
  resetHooks()
  const added = []
  const deleted = []
  const settings = { ...SETTINGS, deepseek: { ...SETTINGS.deepseek, extraKeys: [] } }
  let tree = render(internals.ServiceForm, {
    service: 'deepseek',
    settings,
    t,
    onSave: async () => {},
    onClear: async () => {},
    onAddExtra: async (service, patch) => { added.push([service, patch]) },
    onDeleteExtra: async (service, id) => { deleted.push([service, id]) }
  })
  const inputs = findAll(tree, (element) => element.type === 'input')
  const labelInput = inputs.find((element) => element.props.placeholder === '例如：备用 / 团队 B')
  inputs[inputs.length - 1].props.onChange({ target: { value: 'sk-extra1234567890' } })
  labelInput.props.onChange({ target: { value: '备用' } })
  tree = render(internals.ServiceForm, {
    service: 'deepseek',
    settings,
    t,
    onSave: async () => {},
    onClear: async () => {},
    onAddExtra: async (service, patch) => { added.push([service, patch]) },
    onDeleteExtra: async (service, id) => { deleted.push([service, id]) }
  })
  const add = find(tree, (element) => element.type === 'button' && treeText(element) === '添加')
  await add.props.onClick()
  await flush(2)
  deepEqual(added, [['deepseek', { label: '备用', apiKey: 'sk-extra1234567890' }]])
})

test('the service form deletes an additional key by id', async () => {
  resetHooks()
  const deleted = []
  const settings = {
    ...SETTINGS,
    deepseek: { ...SETTINGS.deepseek, extraKeys: [{ id: 'key-1', label: '备用', masked: 'sk-…9abc' }] }
  }
  const tree = render(internals.ServiceForm, {
    service: 'deepseek',
    settings,
    t,
    onSave: async () => {},
    onClear: async () => {},
    onAddExtra: async () => {},
    onDeleteExtra: async (service, id) => { deleted.push([service, id]) }
  })
  const remove = find(tree, (element) => element.type === 'button' && treeText(element).includes('删除'))
  await remove.props.onClick()
  await flush(2)
  deepEqual(deleted, [['deepseek', 'key-1']])
})

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

test('the page renders custom sources and opens their editor tab', async () => {
  resetHooks()
  context.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, snapshot: snapshotFixture({ custom: customCard() }) })
  })
  render(internals.UsagePage, { t })
  await flush()
  let ready = render(internals.UsagePage, { t })
  const custom = find(ready, (element) => element.type === internals.CustomCard)
  ok(custom !== undefined, 'the custom card is rendered')
  custom.props.onConfigure()
  ready = render(internals.UsagePage, { t })
  const panel = find(ready, (element) => element.type === internals.ConfigPanel)
  equal(panel.props.initialService, 'custom')
})

test('a custom source API failure is isolated and explained', async () => {
  resetHooks()
  context.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      snapshot: snapshotFixture({
        custom: customCard({
          state: 'error',
          source: 'none',
          balance: null,
          fetchedAt: null,
          error: { code: 'custom-path', message: 'missing' }
        })
      })
    })
  })
  render(internals.UsagePage, { t })
  await flush()
  const ready = render(internals.UsagePage, { t })
  const custom = find(ready, (element) => element.type === internals.CustomCard)
  equal(custom.props.card.error.code, 'custom-path')
  ok(find(ready, (element) => element.type === internals.DeepSeekCard) !== undefined, 'the built-in cards still render')
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
