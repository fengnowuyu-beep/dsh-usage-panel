/**
 * dsh-usage-panel — Host half.
 *
 * Owns everything the browser must not own:
 *
 *  - the DeepSeek key (read from `<DSH_HOME>/usage-panel/credentials.json` or
 *    `$DEEPSEEK_API_KEY`; the page is only ever told a mask),
 *  - the one outbound probe (`GET /user/balance`, hard 5 s deadline, no retry),
 *  - the last successful reply, cached on disk so a restart or an outage still
 *    has something honest to show,
 *  - DSH's own usage ledger (read-only),
 *  - the loopback-only JSON route family the panel posts to.
 *
 * Failure policy: nothing here throws out of `apply()`, and no route waits on
 * the network longer than the configured deadline. A dead provider or a corrupt
 * settings file degrades one card, never the page and never DSH startup.
 */
import { resolveDshHome, loadSettings, resolveApiKey, maskKey, keyFingerprint, loadBalanceCache, saveBalanceCache, clearBalanceCache, saveSettings, saveCredentials, validateApiKey, validateBaseUrl, normalizeTimeout, ledgerPath, settingsPath, credentialsPath } from './config.js'
import { RemoteError, fetchBalance } from './deepseek.js'
import { readLedger } from './ledger.js'

/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/usage-panel/api'

/** Cordis services required before the routes can mount. */
export const inject = ['webServer']

/** Route methods the browser half may call. */
const ROUTE_METHODS = new Set(['snapshot', 'refresh', 'test', 'settings.get', 'settings.update'])

/** How long a successful balance stays "实时" before the card calls it cached. */
export const LIVE_TTL_MS = 60_000

/** Largest request body accepted; the settings form is a few hundred bytes. */
const MAX_BODY_BYTES = 64_000

/** One route-level failure carrying its HTTP status. */
class HttpError extends Error {
  /**
   * @param status - the HTTP status.
   * @param code - a stable machine code.
   * @param message - a Host-side description.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** Write one JSON response. */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/** Whether one address is loopback. */
function isLoopbackAddress(address) {
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  const candidate = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  const parts = candidate.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether one hostname names loopback. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isLoopbackAddress(hostname)
}

/**
 * Loopback-only request fence, mirroring the `/api` gateway's posture: a remote
 * address must be loopback, the Host header must name loopback, and a present
 * Origin must be same-host.
 */
function isTrusted(request) {
  const remote = request?.socket?.remoteAddress
  if (typeof remote === 'string' && !isLoopbackAddress(remote)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Read a JSON body with a hard size cap. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
  }
}

/** Project a remote failure onto the wire shape (never the key). */
function publicError(error) {
  if (error instanceof RemoteError) {
    const shape = { code: error.code, message: error.message }
    if (typeof error.status === 'number') shape.status = error.status
    return shape
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

/** The engine. Exposed for the offline suite; the Loader only needs `apply`. */
export class UsagePanel {
  /**
   * @param options - `{ logger, config, dshHome, fetchImpl, now, env }`.
   */
  constructor(options = {}) {
    this.logger = options.logger ?? console
    this.config = options.config ?? {}
    this.home = typeof options.dshHome === 'string' && options.dshHome !== ''
      ? options.dshHome
      : resolveDshHome(this.config.dshHome)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
    this.env = options.env ?? process.env

    this.settings = loadSettings(this.home)
    this.cache = loadBalanceCache(this.home)
    /** `{ at, ok, ms, error }` for the most recent refresh this process made. */
    this.lastAttempt = null
    /** Last good ledger read, served when a write catches the file mid-flush. */
    this.ledgerCache = null
    /** In-flight refresh, so N open pages cause one request, not N. */
    this.inflight = null
    this.disposed = false
  }

  /** The key in force, with where it came from. Never logged or returned. */
  keyInfo() {
    return resolveApiKey(this.home, this.env)
  }

  /** The cached reply, but only when it belongs to the key in force. */
  cachedBalance(key) {
    if (this.cache === null) return null
    if (this.cache.fingerprint !== keyFingerprint(key.apiKey)) return null
    return this.cache
  }

  /** The settings projection the page is allowed to see. */
  publicSettings() {
    const key = this.keyInfo()
    return {
      baseUrl: this.settings.baseUrl,
      timeoutMs: this.settings.timeoutMs,
      currency: this.settings.currency,
      hasKey: key.apiKey !== '',
      maskedKey: maskKey(key.apiKey),
      keySource: key.source,
      savedAt: this.settings.savedAt ?? null,
      ledgerFile: ledgerPath(this.home),
      settingsFile: settingsPath(this.home),
      credentialsFile: credentialsPath(this.home)
    }
  }

  /**
   * Read the ledger, serving the previous read when the file is mid-write.
   * @returns the ledger summary plus a `stale` flag when served from memory.
   */
  ledgerSummary() {
    const fresh = readLedger(ledgerPath(this.home), this.now())
    if (fresh.available) {
      this.ledgerCache = fresh
      return fresh
    }
    if (this.ledgerCache !== null) {
      return { ...this.ledgerCache, stale: true, error: fresh.error }
    }
    return fresh
  }

  /** Build the whole page payload. Pure reads: never touches the network. */
  snapshot() {
    const key = this.keyInfo()
    const cached = this.cachedBalance(key)
    const ledger = this.ledgerSummary()
    const attempt = this.lastAttempt
    const now = Date.now()

    let source = 'none'
    let state = 'idle'
    if (cached !== null) {
      const fresh = now - cached.fetchedAt <= LIVE_TTL_MS
      // "实时" means this process actually read the API; a fresh-looking file
      // left by the previous process is still a cache until a refresh says so.
      const verified = attempt !== null && attempt.ok === true
      source = fresh && verified ? 'live' : 'cache'
    }
    if (key.apiKey === '') state = 'unconfigured'
    else if (source === 'live') state = 'live'
    else if (source === 'cache') state = 'cached'
    else if (attempt !== null && attempt.ok === false) state = 'error'

    const ledgerKnown = ledger.available || ledger.stale === true
    // The card carries the official balance only. Spend lives in the summary bar
    // and the ledger detail, because the two are different questions.
    const deepseek = {
      id: 'deepseek',
      name: 'DeepSeek',
      kind: 'remote',
      state,
      source,
      available: cached?.balance?.isAvailable ?? null,
      balance: cached?.balance?.primary ?? null,
      items: cached?.balance?.items ?? [],
      fetchedAt: cached?.fetchedAt ?? null,
      error: attempt !== null && attempt.ok === false ? attempt.error : null,
      key: { configured: key.apiKey !== '', masked: maskKey(key.apiKey), source: key.source }
    }

    const ledgerState = ledger.available ? (ledger.stale === true ? 'cached' : 'live') : 'unavailable'
    const ledgerError = ledger.stale === true
      ? { code: ledger.error?.code ?? 'unreadable' }
      : ledger.available
        ? null
        : { code: ledger.error?.code ?? 'unreadable' }
    const ledgerCard = {
      id: 'ledger',
      name: 'DSH 本地账本',
      kind: 'local',
      state: ledgerState,
      source: ledger.available ? (ledger.stale === true ? 'cache' : 'live') : 'none',
      today: ledger.today,
      month: ledger.month,
      series: ledger.series,
      models: ledger.models ?? [],
      providers: ledger.providers ?? [],
      updatedAt: ledger.updatedAt ?? null,
      stale: ledger.stale === true,
      error: ledgerError,
      file: ledgerPath(this.home)
    }

    // The balance-card row: P1 adds MiniMax and Aliyun here; the ledger is not a
    // card any more (it is the spend summary plus the collapsible detail).
    const cards = [deepseek]
    const counts = { live: 0, cached: 0, unconfigured: 0, error: 0, idle: 0 }
    for (const card of cards) {
      if (card.state === 'live') counts.live += 1
      else if (card.state === 'cached') counts.cached += 1
      else if (card.state === 'unconfigured') counts.unconfigured += 1
      else if (card.state === 'error') counts.error += 1
      else counts.idle += 1
    }

    return {
      generatedAt: Date.now(),
      cards,
      deepseek,
      ledger: ledgerCard,
      summary: {
        services: cards.length,
        ...counts,
        monthCost: ledgerKnown ? ledger.month.cost : null,
        todayCost: ledgerKnown ? ledger.today.cost : null,
        monthCalls: ledgerKnown ? ledger.month.calls : null,
        ledgerState,
        ledgerUpdatedAt: ledger.updatedAt ?? null,
        // 按服务拆分的本月消耗：跨服务汇总条与 P1 的扩展都读这一份。
        servicesSpend: ledgerKnown
          ? ledger.providers.map((entry) => ({
              id: entry.name,
              name: entry.providerName,
              monthCost: entry.month.cost,
              monthCalls: entry.month.calls,
              todayCost: entry.today.cost
            }))
          : []
      },
      lastAttempt: attempt === null ? null : { at: attempt.at, ok: attempt.ok, ms: attempt.ms, error: attempt.error },
      settings: this.publicSettings()
    }
  }

  /**
   * Probe the provider and fold the result into the cache. Never rejects: a
   * failure is recorded on the card and the previous cache is kept.
   * @returns the refreshed snapshot.
   */
  async refresh() {
    if (this.disposed) return this.snapshot()
    const key = this.keyInfo()
    if (key.apiKey === '') return this.snapshot()
    if (this.inflight !== null) {
      await this.inflight
      return this.snapshot()
    }
    const started = Date.now()
    this.inflight = (async () => {
      try {
        const result = await fetchBalance({
          apiKey: key.apiKey,
          baseUrl: this.settings.baseUrl,
          timeoutMs: this.settings.timeoutMs,
          fetchImpl: this.fetchImpl,
          preferredCurrency: this.settings.currency
        })
        const fetchedAt = Date.now()
        this.cache = { balance: result.balance, fetchedAt, fingerprint: keyFingerprint(key.apiKey) }
        this.lastAttempt = { at: fetchedAt, ok: true, ms: result.ms, error: null }
        try {
          await saveBalanceCache(this.home, this.cache)
        } catch (error) {
          // A cache write failure only costs the next restart its head start.
          this.logger.warn?.(`usage-panel: could not persist the balance cache: ${String(error?.message ?? error)}`)
        }
      } catch (error) {
        // Keep an unexpected failure's text out of the wire entirely: it is the
        // one path where a provider message could echo request details.
        const remote = error instanceof RemoteError ? error : new RemoteError('unknown', 'unexpected refresh failure')
        this.lastAttempt = { at: Date.now(), ok: false, ms: Date.now() - started, error: publicError(remote) }
        this.logger.warn?.(`usage-panel: balance refresh failed (${remote.code})`)
      } finally {
        this.inflight = null
      }
    })()
    await this.inflight
    return this.snapshot()
  }

  /**
   * The "测试连接" action: a real probe (not the cache), reported with latency.
   * @returns `{ ok, ms, balance, items, error, snapshot }`.
   */
  async testConnection() {
    if (this.keyInfo().apiKey === '') {
      return {
        ok: false,
        ms: null,
        balance: null,
        items: [],
        error: { code: 'no-key', message: 'no DeepSeek API key is configured' },
        snapshot: this.snapshot()
      }
    }
    const snapshot = await this.refresh()
    const attempt = this.lastAttempt
    return {
      ok: attempt !== null && attempt.ok === true,
      ms: attempt?.ms ?? null,
      balance: snapshot.deepseek.balance,
      items: snapshot.deepseek.items,
      error: snapshot.deepseek.error,
      snapshot
    }
  }

  /**
   * Apply a settings patch. Changing the key or the endpoint drops the cached
   * balance: it belonged to the previous account.
   * @param patch - `{ apiKey?, clearKey?, baseUrl?, timeoutMs? }`.
   * @returns `{ settings, snapshot }`.
   */
  async updateSettings(patch) {
    if (patch === null || typeof patch !== 'object') throw new HttpError(400, 'bad-request', 'settings patch must be an object')
    const next = { ...this.settings }
    let settingsChanged = false
    let keyChanged = false

    if (patch.clearKey === true) {
      const current = this.keyInfo()
      if (current.source !== 'file') {
        // A key from the environment cannot be removed by deleting a file; say so
        // instead of reporting a save that did nothing.
        if (current.source === 'env') throw new HttpError(409, 'key-from-env', 'the key is set by DEEPSEEK_API_KEY')
      }
      await saveCredentials(this.home, '')
      keyChanged = true
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
      const valid = validateApiKey(patch.apiKey)
      if (!valid.ok) throw new HttpError(400, valid.code, 'the API key is not usable')
      await saveCredentials(this.home, valid.value)
      keyChanged = true
    }

    if (typeof patch.baseUrl === 'string') {
      const valid = validateBaseUrl(patch.baseUrl)
      if (!valid.ok) throw new HttpError(400, valid.code, 'the API root is not usable')
      if (valid.value !== next.baseUrl) {
        next.baseUrl = valid.value
        settingsChanged = true
        keyChanged = true
      }
    }

    if (patch.timeoutMs !== undefined) {
      const timeoutMs = normalizeTimeout(patch.timeoutMs)
      if (timeoutMs !== next.timeoutMs) {
        next.timeoutMs = timeoutMs
        settingsChanged = true
      }
    }

    if (settingsChanged) {
      await saveSettings(this.home, next)
      this.settings = loadSettings(this.home)
    }

    if (keyChanged) {
      this.cache = null
      this.lastAttempt = null
      await clearBalanceCache(this.home)
    }

    return { settings: this.publicSettings(), snapshot: this.snapshot() }
  }

  /** Release the engine. No timers or sockets are held, so this is bookkeeping. */
  dispose() {
    this.disposed = true
  }
}

/**
 * Mount the Host half.
 * @param ctx - the Cordis Host context (provides `webServer`).
 * @param config - optional Loader config (`enabled`, `dshHome`).
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger?.info?.('usage-panel: disabled by config')
    return
  }
  const logger = ctx.logger ?? console
  let panel
  try {
    panel = new UsagePanel({ logger, config })
  } catch (error) {
    // The page will render its Host-unavailable state; DSH startup is untouched.
    logger.warn?.(`usage-panel: could not initialize: ${String(error?.message ?? error)}`)
    return
  }
  const engine = panel

  ctx.effect(() => () => engine.dispose(), 'usage-panel: engine')

  ctx.effect(() => {
    try {
      return ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (request, response) => {
          if (!isTrusted(request)) {
            writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (request.method !== 'POST') {
            writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
            return
          }
          const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${ROUTE_PREFIX}/`)
            ? pathname.slice(ROUTE_PREFIX.length + 1)
            : undefined
          if (method === undefined || !ROUTE_METHODS.has(method)) {
            writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${String(method)}"` } })
            return
          }

          try {
            // Always drain the body: an unconsumed request stream can keep the
            // connection in a half-read state even when the method needs no input.
            const payload = await readJsonBody(request)
            switch (method) {
              case 'snapshot':
              case 'settings.get':
                writeJson(response, 200, { ok: true, snapshot: engine.snapshot() })
                return
              case 'refresh':
                writeJson(response, 200, { ok: true, snapshot: await engine.refresh() })
                return
              case 'test':
                writeJson(response, 200, { ok: true, result: await engine.testConnection() })
                return
              case 'settings.update': {
                const result = await engine.updateSettings(payload)
                writeJson(response, 200, { ok: true, settings: result.settings, snapshot: result.snapshot })
                return
              }
              default:
                writeJson(response, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
            }
          } catch (error) {
            const status = error instanceof HttpError ? error.status : 500
            const code = error instanceof HttpError ? error.code : 'internal-error'
            const message = error instanceof Error ? error.message : String(error)
            if (status >= 500) logger.warn?.(`usage-panel: ${method} failed: ${message}`)
            if (!response.writableEnded) writeJson(response, status, { ok: false, error: { code, message } })
          }
        }
      })
    } catch (error) {
      // A port conflict or a replaced web server must not take plugin activation
      // down: the page will show its Host-unavailable state instead.
      logger.warn?.(`usage-panel: could not mount ${ROUTE_PREFIX}: ${String(error?.message ?? error)}`)
      return () => {}
    }
  }, 'usage-panel: routes')

  const key = engine.keyInfo()
  logger.info?.(`usage-panel: mounted ${ROUTE_PREFIX} (DeepSeek key: ${key.apiKey === '' ? 'not configured' : key.source}; ledger: ${ledgerPath(engine.home)})`)
}
