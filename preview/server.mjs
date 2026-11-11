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
 * Modes: live | cached | unconfigured | error | no-ledger
 */
import http from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ledgerPath, resolveDshHome } from '../lib/config.js'
import { readLedger } from '../lib/ledger.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

const argPort = process.argv.find((value) => value.startsWith('--port='))
const port = Number(argPort?.slice('--port='.length) ?? process.env.PORT ?? 8791)

/** The current preview state, chosen by the page's `?mode=` parameter. */
const MODES = new Set(['live', 'cached', 'unconfigured', 'error', 'no-ledger'])
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
  // `no-ledger` exists to show the DeepSeek card healthy next to a missing
  // ledger, so it behaves like `live` for the provider half.
  const providerMode = mode === 'no-ledger' ? 'live' : mode
  const balance = configured && providerMode !== 'error' ? SAMPLE_BALANCE : null
  const hasCache = configured && (providerMode === 'live' || providerMode === 'cached')
  const failed = providerMode === 'cached' || providerMode === 'error'
  let state = 'unconfigured'
  let source = 'none'
  let error = null
  if (configured) {
    if (providerMode === 'live') { state = 'live'; source = 'live' }
    else if (providerMode === 'cached') { state = 'cached'; source = 'cache'; error = { code: 'timeout', message: 'preview fixture' } }
    else { state = 'error'; error = { code: 'unauthorized', message: 'preview fixture' } }
  }

  const deepseek = {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'remote',
    state,
    source,
    available: balance === null ? null : balance.isAvailable,
    balance: hasCache ? balance.primary : null,
    items: hasCache ? balance.items : [],
    fetchedAt: hasCache ? (mode === 'cached' ? now - 15 * 60_000 : now) : null,
    error,
    key: {
      configured,
      masked: configured ? 'sk-…3f2a' : '',
      source: configured ? 'file' : 'none'
    }
  }

  const live = deepseek.state === 'live' ? 1 : 0
  const cached = deepseek.state === 'cached' ? 1 : 0
  const failedCount = deepseek.state === 'error' ? 1 : 0
  const unconfigured = deepseek.state === 'unconfigured' ? 1 : 0

  return {
    generatedAt: now,
    cards: [deepseek],
    deepseek,
    ledger,
    summary: {
      services: 1,
      live,
      cached,
      unconfigured,
      error: failedCount,
      idle: 0,
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
    lastAttempt: failed
      ? { at: now - 60_000, ok: false, ms: 5000, error }
      : configured
        ? { at: now, ok: true, ms: 128, error: null }
        : null,
    settings: {
      baseUrl: 'https://api.deepseek.com',
      timeoutMs: 5000,
      currency: 'CNY',
      hasKey: configured,
      maskedKey: configured ? 'sk-…3f2a' : '',
      keySource: configured ? 'file' : 'none',
      savedAt: now,
      ledgerFile: file,
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
    const snapshot = buildSnapshot()
    let payload
    if (method === 'test') {
      const ok = mode === 'live'
      payload = {
        ok: true,
        result: {
          ok,
          ms: ok ? 128 : 5000,
          balance: ok ? SAMPLE_BALANCE.primary : null,
          items: ok ? SAMPLE_BALANCE.items : [],
          error: ok ? null : { code: mode === 'cached' ? 'timeout' : 'unauthorized', message: 'preview fixture' },
          snapshot
        }
      }
    } else {
      payload = { ok: true, snapshot }
    }
    const text = JSON.stringify(payload)
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
