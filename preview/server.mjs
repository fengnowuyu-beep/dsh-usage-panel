/**
 * Local visual harness for the panel, not part of the plugin.
 *
 * Serves `preview.html` plus the real `lib/client.js`, vendors React (UMD) for
 * the page, and answers the four route methods with a snapshot built from the
 * machine's real usage ledger. The DeepSeek balance is a fixture — the point is
 * to see all card states without spending a request or configuring a key.
 *
 *   node preview/server.mjs            # http://127.0.0.1:8791/?mode=live
 *   node preview/server.mjs --port=9000
 *
 * Modes: live | cached | unconfigured | error | no-ledger | custom | alert
 */
import http from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ledgerPath, resolveDshHome } from '../lib/config.js'
import { buildExport } from '../lib/csv.js'
import { readLedger } from '../lib/ledger.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

const argPort = process.argv.find((value) => value.startsWith('--port='))
const port = Number(argPort?.slice('--port='.length) ?? process.env.PORT ?? 8791)

/** The current preview state, chosen by the page's `?mode=` parameter. */
const MODES = new Set(['live', 'cached', 'unconfigured', 'error', 'no-ledger', 'custom', 'alert', 'payg'])
let mode = 'live'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
}

/** The sample balance every preview mode shares, so the card layout is stable. */
const SAMPLE_BALANCE = {
  isAvailable: true,
  primary: { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
  items: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }]
}

/** Serve one file from disk, refusing anything outside the package. */
function sendFile(response, file) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
    return
  }
  const body = readFileSync(file)
  response.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store'
  })
  response.end(body)
}

/** Project the ledger into the shape the browser card expects. */
function projectLedger(summary) {
  return {
    id: 'ledger',
    name: 'DSH 本地账本',
    kind: 'local',
    state: summary.available ? 'live' : 'unavailable',
    source: summary.available ? 'live' : 'none',
    today: summary.today,
    month: summary.month,
    series: summary.series,
    models: summary.models ?? [],
    updatedAt: summary.updatedAt ?? null,
    stale: false,
    error: summary.available ? null : { code: summary.error?.code ?? 'missing' },
    file: summary.file
  }
}

/** A MiniMax Token Plan fixture: two models, both windows. */
function minimaxQuota() {
  const model = (name, intervalRemaining, weeklyRemaining) => ({
    name,
    plan: 'Plus',
    interval: {
      total: 1000,
      used: Math.round(1000 * (100 - intervalRemaining) / 100),
      remainingPercent: intervalRemaining,
      usedPercent: 100 - intervalRemaining,
      startAt: null,
      endAt: Date.now() + 2 * 60 * 60_000,
      remainsAt: null
    },
    weekly: {
      total: 10000,
      used: Math.round(10000 * (100 - weeklyRemaining) / 100),
      remainingPercent: weeklyRemaining,
      usedPercent: 100 - weeklyRemaining,
      startAt: null,
      endAt: null,
      remainsAt: null
    }
  })
  const models = [model('general', 62, 38), model('video', 91, 84)]
  return { plan: 'Plus', models, primary: models[0] }
}

/** An Aliyun BSS balance fixture. */
const SAMPLE_ALIYUN = {
  available: 10000,
  cash: 9500,
  credit: 500,
  mybankCredit: 0,
  quotaLimit: 10000,
  currency: 'CNY'
}

/** Preview-only session rows; the banner says the data is illustrative. */
const PREVIEW_SESSIONS = {
  monthKey: '2026-11',
  sessions: [
    { id: 'session-a', title: '服务余额与用量面板插件', calls: 342, tokens: 1280000, cost: 3.42, unpricedCalls: 0, unpricedModels: [], lastAt: Date.now() },
    { id: 'session-b', title: '插件需求评估', calls: 118, tokens: 420000, cost: 1.18, unpricedCalls: 0, unpricedModels: [], lastAt: Date.now() },
    { id: 'session-c', title: 'P1 会话统计验证', calls: 47, tokens: 96000, cost: 0.36, unpricedCalls: 0, unpricedModels: [], lastAt: Date.now() }
  ],
  totalSessions: 3,
  scanned: 12,
  skipped: 0,
  durationMs: 87,
  pricing: { label: 'DeepSeek 官方标价（CNY，2026-10-08 版）' },
  cached: false,
  ageMs: 0
}

/** Build the whole page payload for the requested mode. */
function buildSnapshot() {
  const now = Date.now()
  const home = resolveDshHome(process.env.DSH_HOME)
  const file = ledgerPath(home)
  const real = readLedger(file, new Date(now))
  const ledgerSource = mode === 'no-ledger'
    ? { ...real, available: false, error: { code: 'missing' }, updatedAt: null }
    : real
  // The preview must not bake this machine's user name into screenshots; the
  // panel treats the path as an opaque label, so a `~` form is honest enough.
  const displayFile = '~/.dsh/dsh-usage/usage-ledger.json'
  const ledger = { ...projectLedger(ledgerSource), file: displayFile }

  const configured = mode !== 'unconfigured'
  const deepseekCached = mode === 'cached'
  const deepseekError = mode === 'error'
  const deepseekState = !configured ? 'unconfigured'
    : deepseekError ? 'error'
      : deepseekCached ? 'cached' : 'live'
  const deepseekSource = deepseekState === 'live' ? 'live' : deepseekState === 'cached' ? 'cache' : 'none'
  const deepseekFetchedAt = deepseekState === 'live'
    ? now
    : deepseekState === 'cached' ? now - 15 * 60_000 : null
  const deepseek = {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'remote',
    state: deepseekState,
    source: deepseekSource,
    available: configured && !deepseekError ? SAMPLE_BALANCE.isAvailable : null,
    balance: configured && !deepseekError ? SAMPLE_BALANCE.primary : null,
    items: configured && !deepseekError ? SAMPLE_BALANCE.items : [],
    fetchedAt: deepseekFetchedAt,
    error: deepseekError
      ? { code: 'unauthorized', message: 'preview fixture' }
      : deepseekCached ? { code: 'timeout', message: 'preview fixture' } : null,
    key: { configured, masked: configured ? 'sk-…3f2a' : '', source: configured ? 'file' : 'none' }
  }

  const minimax = {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'remote',
    state: !configured ? 'unconfigured'
      : mode === 'error' ? 'error'
        : mode === 'cached' ? 'cached' : 'live',
    source: mode === 'error' || !configured ? 'none' : mode === 'cached' ? 'cache' : 'live',
    fetchedAt: !configured || mode === 'error' ? null : mode === 'cached' ? now - 15 * 60_000 : now,
    error: mode === 'error' ? { code: 'minimax-no-plan', message: 'preview fixture' } : null,
    key: { configured, masked: configured ? 'mm-…9b2c' : '', source: configured ? 'file' : 'none' },
    quota: !configured || mode === 'error' ? null : minimaxQuota()
  }

  const aliyun = {
    id: 'aliyun',
    name: '阿里云',
    kind: 'remote',
    state: !configured ? 'unconfigured'
      : mode === 'error' ? 'error'
        : mode === 'cached' ? 'cached' : 'live',
    source: mode === 'error' || !configured ? 'none' : mode === 'cached' ? 'cache' : 'live',
    fetchedAt: !configured || mode === 'error' ? null : mode === 'cached' ? now - 15 * 60_000 : now,
    error: mode === 'error' ? { code: 'aliyun-signature', message: 'preview fixture' } : null,
    key: { configured, masked: configured ? 'LTAI…eyId' : '', source: configured ? 'file' : 'none' },
    balance: !configured || mode === 'error' ? null : SAMPLE_ALIYUN
  }

  const custom = {
    id: 'custom-abcd1234',
    name: '示例余额',
    kind: 'custom',
    state: 'live',
    source: 'live',
    fetchedAt: now,
    error: null,
    key: { configured: true, masked: '', source: 'file' },
    custom: {
      url: 'https://api.example.com/balance',
      valuePath: 'data.balance',
      currency: 'CNY',
      headers: [{ name: 'Authorization', masked: '…oken' }]
    },
    balance: { value: 55.5, currency: 'CNY' }
  }

  const alertMode = mode === 'alert'
  const paygMode = mode === 'payg'
  if (paygMode) {
    minimax.quota = null
    minimax.payg = { amount: 13.91, currency: 'CNY', cash: 0, voucher: 13.91, credit: 0, owed: 0 }
  }
  const customMode = mode === 'custom'
  if (alertMode) {
    deepseek.alert = { threshold: 200, value: 110 }
    minimax.alert = { threshold: 80, value: 62 }
    aliyun.alert = { threshold: 20000, value: 10000 }
    custom.alert = { threshold: 100, value: 55.5 }
  }

  deepseek.keys = [
    {
      id: 'primary',
      label: '主 Key',
      masked: 'sk-…3f2a',
      state: deepseek.state,
      source: deepseek.source,
      fetchedAt: deepseek.fetchedAt,
      error: deepseek.error,
      balance: deepseek.balance,
      remainingPercent: null
    },
    {
      id: 'key-demo0001',
      label: '备用 Key',
      masked: 'sk-…9b2c',
      state: deepseek.state,
      source: deepseek.source,
      fetchedAt: deepseek.fetchedAt,
      error: null,
      balance: { currency: 'CNY', total: 220, granted: 0, toppedUp: 220 },
      remainingPercent: null
    }
  ]

  const cards = [deepseek, minimax, aliyun, ...(customMode || alertMode ? [custom] : [])]
  const counts = { live: 0, cached: 0, unconfigured: 0, error: 0, idle: 0 }
  for (const card of cards) {
    if (card.state === 'live') counts.live += 1
    else if (card.state === 'cached') counts.cached += 1
    else if (card.state === 'unconfigured') counts.unconfigured += 1
    else if (card.state === 'error') counts.error += 1
    else counts.idle += 1
  }

  return {
    generatedAt: now,
    cards,
    ledger,
    summary: {
      services: cards.length,
      ...counts,
      monthCost: ledgerSource.available ? ledgerSource.month.cost : null,
      todayCost: ledgerSource.available ? ledgerSource.today.cost : null,
      monthCalls: ledgerSource.available ? ledgerSource.month.calls : null,
      ledgerState: ledgerSource.available ? 'live' : 'unavailable',
      ledgerUpdatedAt: ledgerSource.updatedAt ?? null,
      servicesSpend: ledgerSource.available
        ? ledgerSource.providers.map((entry) => ({
            id: entry.name,
            name: entry.providerName,
            monthCost: entry.month.cost,
            monthCalls: entry.month.calls,
            todayCost: entry.today.cost
          }))
        : []
    },
    lastAttempts: {
      deepseek: deepseek.error === null ? { at: now, ok: true, ms: 128, error: null } : { at: now - 60_000, ok: false, ms: 5000, error: deepseek.error },
      minimax: minimax.error === null ? { at: now, ok: true, ms: 210, error: null } : { at: now - 60_000, ok: false, ms: 5000, error: minimax.error },
      aliyun: aliyun.error === null ? { at: now, ok: true, ms: 260, error: null } : { at: now - 60_000, ok: false, ms: 5000, error: aliyun.error }
    },
    settings: {
      timeoutMs: 5000,
      deepseek: {
        baseUrl: 'https://api.deepseek.com',
        hasKey: configured,
        maskedKey: configured ? 'sk-…3f2a' : '',
        keySource: configured ? 'file' : 'none',
        savedAt: configured ? now : null,
        extraKeys: configured
          ? [{ id: 'key-demo0001', label: '备用 Key', masked: 'sk-…9b2c' }]
          : []
      },
      minimax: { region: 'cn', hasKey: configured, maskedKey: configured ? 'mm-…9b2c' : '', keySource: configured ? 'file' : 'none' },
      aliyun: { endpoint: 'business.aliyuncs.com', hasKey: configured, accessKeyIdMasked: configured ? 'LTAI…eyId' : '', keySource: configured ? 'file' : 'none' },
      alerts: alertMode
        ? { enabled: true, desktop: false, thresholds: { deepseek: 200, minimax: 80, aliyun: 20000, 'custom-abcd1234': 100 } }
        : { enabled: true, desktop: false, thresholds: {} },
      customSources: customMode || alertMode
        ? [{ id: custom.id, name: custom.name, url: custom.custom.url, valuePath: custom.custom.valuePath, currency: 'CNY', headers: custom.custom.headers }]
        : [],
      ledgerFile: displayFile,
      settingsFile: join(home, 'usage-panel', 'settings.json'),
      credentialsFile: join(home, 'usage-panel', 'credentials.json')
    }
  }
}

/** Answer one of the route methods the browser half posts to. */
function respondApi(request, response, method) {
  let body = ''
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    const payload = body.trim() === '' ? {} : (() => {
      try {
        return JSON.parse(body)
      } catch {
        return {}
      }
    })()
    const snapshot = buildSnapshot()
    let result
    if (method === 'sessions') {
      result = { ok: true, sessions: PREVIEW_SESSIONS }
    } else if (method === 'test') {
      const service = typeof payload.service === 'string' ? payload.service : 'deepseek'
      const card = snapshot.cards.find((entry) => entry.id === service) ?? snapshot.cards[0]
      result = {
        ok: true,
        result: {
          service: card.id,
          ok: card.state === 'live',
          ms: card.state === 'live' ? 128 : 5000,
          error: card.error,
          card,
          snapshot
        }
      }
    } else if (method === 'settings.update') {
      result = { ok: true, settings: snapshot.settings, snapshot }
    } else {
      result = { ok: true, snapshot }
    }
    const text = JSON.stringify(result)
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store'
    })
    response.end(text)
  })
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  const pathname = url.pathname

  if (pathname === '/' || pathname === '/index.html') {
    const requested = url.searchParams.get('mode') ?? 'live'
    mode = MODES.has(requested) ? requested : 'live'
    sendFile(response, join(here, 'preview.html'))
    return
  }
  if (pathname === '/client.js') {
    sendFile(response, join(packageRoot, 'lib', 'client.js'))
    return
  }
  if (pathname === '/vendor/react.production.min.js' || pathname === '/vendor/react-dom.production.min.js') {
    sendFile(response, join(here, normalize(pathname.slice(1))))
    return
  }
  if (pathname.startsWith('/usage-panel/api/')) {
    if (request.method === 'GET' && pathname === '/usage-panel/api/export') {
      const scope = url.searchParams.get('scope') ?? ''
      const result = buildExport(scope, scope === 'sessions' ? PREVIEW_SESSIONS : buildSnapshot(), new Date())
      if (result === null) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: { code: 'bad-scope', message: 'unknown scope' } }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${result.filename}"`,
        'content-length': Buffer.byteLength(result.csv)
      })
      response.end(result.csv)
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: { code: 'method-error', message: 'POST only' } }))
      return
    }
    respondApi(request, response, pathname.slice('/usage-panel/api/'.length))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`usage-panel preview: http://127.0.0.1:${port}/?mode=live`)
  console.log(`ledger: ${ledgerPath(resolveDshHome(process.env.DSH_HOME))}`)
})
