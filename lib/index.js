/**
 * dsh-usage-panel — Host half.
 *
 * Owns everything the browser must not own:
 *
 *  - the provider credentials (DeepSeek key, MiniMax key, Aliyun RAM
 *    AccessKey pair), read from `<DSH_HOME>/usage-panel/credentials.json` or
 *    the matching environment variables;
 *  - one outbound probe per provider, each with a hard 5 s deadline and no
 *    retry, cached on disk so a restart or an outage still has something
 *    honest to show;
 *  - DSH's own usage ledger (read-only) for the cross-service spend summary;
 *  - session-level usage, derived from the harness session logs on demand;
 *  - the loopback-only JSON route family the panel posts to.
 *
 * Failure policy: nothing here throws out of `apply()`, one provider's failure
 * never touches another card, and no route waits on the network longer than the
 * configured deadline.
 */
import { join } from 'node:path'

import {
  clearCustomCache,
  clearProviderCache,
  credentialsPath,
  keyFingerprint,
  ledgerPath,
  loadCustomCache,
  loadCustomSources,
  loadProviderCache,
  loadSettings,
  maskAccessKeyId,
  maskKey,
  normalizeAlerts,
  normalizeAliyunEndpoint,
  normalizeMinimaxRegion,
  normalizeTimeout,
  resolveAliyunKey,
  resolveApiKey,
  resolveDshHome,
  resolveMinimaxKey,
  saveCustomCache,
  saveCustomSources,
  saveProviderCache,
  saveSettings,
  settingsPath,
  updateServiceCredentials,
  validateAccessKeyId,
  validateAccessKeySecret,
  validateApiKey,
  validateBaseUrl
} from './config.js'
import { evaluateAlert } from './alerts.js'
import { buildCustomSource, customFingerprint, fetchCustomSource, MAX_CUSTOM_SOURCES, publicCustomSource } from './custom.js'
import { fetchBalance } from './deepseek.js'
import { readLedger } from './ledger.js'
import { fetchAliyunBalance } from './providers/aliyun.js'
import { fetchMinimaxQuota } from './providers/minimax.js'
import { RemoteError } from './remote.js'
import { scanSessions } from './sessions.js'

/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/usage-panel/api'

/** Cordis services required before the routes can mount. */
export const inject = ['webServer']

/** Provider ids, in card order. */
export const SERVICES = Object.freeze(['deepseek', 'minimax', 'aliyun'])

/** Display names used in summaries and card titles. */
export const SERVICE_NAMES = Object.freeze({
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  aliyun: '阿里云'
})

/** Route methods the browser half may call. */
const ROUTE_METHODS = new Set(['snapshot', 'refresh', 'test', 'settings.get', 'settings.update', 'sessions', 'custom.save', 'custom.delete'])

/** How long a successful provider reply stays "实时" before it is called cached. */
export const LIVE_TTL_MS = 60_000

/** How long the session scan result is reused. */
export const SESSION_TTL_MS = 60_000

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
 * Loopback-only request fence, mirroring the `/api` gateway's posture.
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

/** Whether a value names a built-in provider. */
function isService(value) {
  return typeof value === 'string' && SERVICES.includes(value)
}

/** Whether a value names a refresh/test target (built-in or a custom source id). */
function isServiceKey(value) {
  return isService(value) || (typeof value === 'string' && /^custom-[0-9a-f]{8}$/.test(value))
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
    const cached = loadProviderCache(this.home)
    this.states = {
      deepseek: { cache: cached.deepseek, attempt: null, inflight: null },
      minimax: { cache: cached.minimax, attempt: null, inflight: null },
      aliyun: { cache: cached.aliyun, attempt: null, inflight: null }
    }
    this.customSources = loadCustomSources(this.home)
    const customCache = loadCustomCache(this.home)
    this.customStates = new Map()
    for (const source of this.customSources) {
      this.customStates.set(source.id, { cache: customCache[source.id] ?? null, attempt: null, inflight: null })
    }
    /** Last good ledger read, served when a write catches the file mid-flush. */
    this.ledgerCache = null
    /** Session scan cache: `{ at, data }`. */
    this.sessionCache = { at: 0, data: null }
    this.sessionTtlMs = Number.isFinite(options.sessionTtlMs) ? options.sessionTtlMs : SESSION_TTL_MS
    this.disposed = false
  }

  /** The credential in force for one provider. Never returned by `snapshot`. */
  keyInfo(service) {
    if (service === 'deepseek') {
      const key = resolveApiKey(this.home, this.env)
      return {
        configured: key.apiKey !== '',
        source: key.source,
        masked: maskKey(key.apiKey),
        fingerprint: keyFingerprint(key.apiKey),
        apiKey: key.apiKey,
        updatedAt: key.updatedAt
      }
    }
    if (service === 'minimax') {
      const key = resolveMinimaxKey(this.home, this.env)
      return {
        configured: key.apiKey !== '',
        source: key.source,
        masked: maskKey(key.apiKey),
        fingerprint: keyFingerprint(key.apiKey),
        apiKey: key.apiKey,
        updatedAt: key.updatedAt
      }
    }
    const key = resolveAliyunKey(this.home, this.env)
    const configured = key.accessKeyId !== '' && key.accessKeySecret !== ''
    return {
      configured,
      source: key.source,
      masked: maskAccessKeyId(key.accessKeyId),
      fingerprint: keyFingerprint(`${key.accessKeyId}\u0000${key.accessKeySecret}`),
      accessKeyId: key.accessKeyId,
      accessKeySecret: key.accessKeySecret,
      updatedAt: key.updatedAt
    }
  }

  /** The cached reply, but only when it belongs to the credential in force. */
  cachedFor(service, key) {
    const entry = this.states[service].cache
    if (entry === null || entry === undefined) return null
    if (entry.fingerprint !== key.fingerprint) return null
    return entry
  }

  /** The settings projection the page is allowed to see. */
  publicSettings() {
    const deepseek = this.keyInfo('deepseek')
    const minimax = this.keyInfo('minimax')
    const aliyun = this.keyInfo('aliyun')
    return {
      timeoutMs: this.settings.timeoutMs,
      deepseek: {
        baseUrl: this.settings.baseUrl,
        hasKey: deepseek.configured,
        maskedKey: deepseek.masked,
        keySource: deepseek.source,
        savedAt: this.settings.savedAt ?? null
      },
      minimax: {
        region: this.settings.minimaxRegion,
        hasKey: minimax.configured,
        maskedKey: minimax.masked,
        keySource: minimax.source
      },
      aliyun: {
        endpoint: this.settings.aliyunEndpoint,
        hasKey: aliyun.configured,
        accessKeyIdMasked: aliyun.masked,
        keySource: aliyun.source
      },
      alerts: normalizeAlerts(this.settings.alerts),
      customSources: this.customSources.map(publicCustomSource),
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

  /** @returns the card for one provider. */
  cardFor(service) {
    const key = this.keyInfo(service)
    const cached = this.cachedFor(service, key)
    const state = this.states[service]
    const attempt = state.attempt
    const now = Date.now()

    let source = 'none'
    let stateName = 'idle'
    if (cached !== null) {
      const fresh = now - cached.fetchedAt <= LIVE_TTL_MS
      const verified = attempt !== null && attempt.ok === true
      source = fresh && verified ? 'live' : 'cache'
    }
    if (!key.configured) stateName = 'unconfigured'
    else if (source === 'live') stateName = 'live'
    else if (source === 'cache') stateName = 'cached'
    else if (attempt !== null && attempt.ok === false) stateName = 'error'

    const card = {
      id: service,
      name: SERVICE_NAMES[service],
      kind: 'remote',
      state: stateName,
      source,
      fetchedAt: cached?.fetchedAt ?? null,
      error: attempt !== null && attempt.ok === false ? attempt.error : null,
      key: { configured: key.configured, masked: key.masked, source: key.source }
    }

    if (service === 'deepseek') {
      const balance = cached?.data?.balance ?? null
      card.balance = balance?.primary ?? null
      card.items = balance?.items ?? []
      card.available = balance?.isAvailable ?? null
    } else if (service === 'minimax') {
      card.quota = cached?.data ?? null
    } else {
      card.balance = cached?.data?.balance ?? null
      card.requestId = cached?.data?.requestId ?? null
    }
    card.alert = evaluateAlert(card, this.settings.alerts)
    return card
  }

  /** @returns the card for one custom source. */
  customCard(source) {
    const state = this.customStates.get(source.id) ?? { cache: null, attempt: null, inflight: null }
    if (!this.customStates.has(source.id)) this.customStates.set(source.id, state)
    const fingerprint = customFingerprint(source)
    const cached = state.cache !== null && state.cache !== undefined && state.cache.fingerprint === fingerprint
      ? state.cache
      : null
    const now = Date.now()
    let sourceName = 'none'
    let stateName = 'idle'
    if (cached !== null) {
      const fresh = now - cached.fetchedAt <= LIVE_TTL_MS
      const verified = state.attempt !== null && state.attempt.ok === true
      sourceName = fresh && verified ? 'live' : 'cache'
    }
    if (sourceName === 'live') stateName = 'live'
    else if (sourceName === 'cache') stateName = 'cached'
    else if (state.attempt !== null && state.attempt.ok === false) stateName = 'error'
    const card = {
      id: source.id,
      name: source.name,
      kind: 'custom',
      state: stateName,
      source: sourceName,
      fetchedAt: cached?.fetchedAt ?? null,
      error: state.attempt !== null && state.attempt.ok === false ? state.attempt.error : null,
      key: { configured: true, masked: '', source: 'file' },
      custom: {
        url: source.url,
        valuePath: source.valuePath,
        currency: source.currency,
        headers: publicCustomSource(source).headers
      },
      balance: cached?.data
        ? { value: cached.data.value, currency: cached.data.currency }
        : null
    }
    card.alert = evaluateAlert(card, this.settings.alerts)
    return card
  }

  /** Build the whole page payload. Pure reads for ledger; no provider calls. */
  snapshot() {
    const ledger = this.ledgerSummary()
    const ledgerKnown = ledger.available || ledger.stale === true
    const cards = [
      ...SERVICES.map((service) => this.cardFor(service)),
      ...this.customSources.map((source) => this.customCard(source))
    ]

    const counts = { live: 0, cached: 0, unconfigured: 0, error: 0, idle: 0 }
    for (const card of cards) {
      if (card.state === 'live') counts.live += 1
      else if (card.state === 'cached') counts.cached += 1
      else if (card.state === 'unconfigured') counts.unconfigured += 1
      else if (card.state === 'error') counts.error += 1
      else counts.idle += 1
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

    return {
      generatedAt: Date.now(),
      cards,
      ledger: ledgerCard,
      summary: {
        services: cards.length,
        ...counts,
        monthCost: ledgerKnown ? ledger.month.cost : null,
        todayCost: ledgerKnown ? ledger.today.cost : null,
        monthCalls: ledgerKnown ? ledger.month.calls : null,
        ledgerState,
        ledgerUpdatedAt: ledger.updatedAt ?? null,
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
      lastAttempts: {
        deepseek: this.states.deepseek.attempt,
        minimax: this.states.minimax.attempt,
        aliyun: this.states.aliyun.attempt
      },
      settings: this.publicSettings()
    }
  }

  /**
   * Probe one provider and fold the result into its cache.
   * @param service - `deepseek` | `minimax` | `aliyun` | a custom source id.
   */
  async refreshService(service) {
    if (this.disposed) return
    if (typeof service === 'string' && service.startsWith('custom-')) {
      await this.refreshCustom(service)
      return
    }
    const key = this.keyInfo(service)
    if (!key.configured) return
    const state = this.states[service]
    if (state.inflight !== null) {
      await state.inflight
      return
    }
    const started = Date.now()
    state.inflight = (async () => {
      try {
        const result = await this.fetchProvider(service, key)
        const fetchedAt = Date.now()
        state.cache = { data: result.data, fetchedAt, fingerprint: key.fingerprint }
        state.attempt = { at: fetchedAt, ok: true, ms: result.ms, error: null }
        try {
          await saveProviderCache(this.home, service, state.cache)
        } catch (error) {
          this.logger.warn?.(`usage-panel: could not persist the ${service} cache: ${String(error?.message ?? error)}`)
        }
      } catch (error) {
        // Keep an unexpected failure's text off the wire: it is the one path
        // where a provider message could echo request details.
        const remote = error instanceof RemoteError ? error : new RemoteError('unknown', 'unexpected refresh failure')
        state.attempt = { at: Date.now(), ok: false, ms: Date.now() - started, error: publicError(remote) }
        this.logger.warn?.(`usage-panel: ${service} refresh failed (${remote.code})`)
      } finally {
        state.inflight = null
      }
    })()
    await state.inflight
  }

  /**
   * Probe one custom source and fold the result into the custom cache.
   * @param id - the custom source id.
   */
  async refreshCustom(id) {
    if (this.disposed) return
    const source = this.customSources.find((entry) => entry.id === id)
    if (source === undefined) return
    let state = this.customStates.get(id)
    if (state === undefined) {
      state = { cache: null, attempt: null, inflight: null }
      this.customStates.set(id, state)
    }
    if (state.inflight !== null) {
      await state.inflight
      return
    }
    const fingerprint = customFingerprint(source)
    const started = Date.now()
    state.inflight = (async () => {
      try {
        const result = await fetchCustomSource(source, {
          timeoutMs: this.settings.timeoutMs,
          fetchImpl: this.fetchImpl
        })
        const fetchedAt = Date.now()
        state.cache = { data: result.data, fetchedAt, fingerprint }
        state.attempt = { at: fetchedAt, ok: true, ms: result.ms, error: null }
        try {
          await saveCustomCache(this.home, id, state.cache)
        } catch (error) {
          this.logger.warn?.(`usage-panel: could not persist the ${id} cache: ${String(error?.message ?? error)}`)
        }
      } catch (error) {
        const remote = error instanceof RemoteError ? error : new RemoteError('unknown', 'unexpected refresh failure')
        state.attempt = { at: Date.now(), ok: false, ms: Date.now() - started, error: publicError(remote) }
        this.logger.warn?.(`usage-panel: ${id} refresh failed (${remote.code})`)
      } finally {
        state.inflight = null
      }
    })()
    await state.inflight
  }

  /**
   * Call one provider adapter.
   * @param service - provider id.
   * @param key - its credential.
   * @returns `{ data, ms }`.
   */
  async fetchProvider(service, key) {
    if (service === 'deepseek') {
      const result = await fetchBalance({
        apiKey: key.apiKey,
        baseUrl: this.settings.baseUrl,
        timeoutMs: this.settings.timeoutMs,
        fetchImpl: this.fetchImpl,
        preferredCurrency: this.settings.currency
      })
      return { data: { balance: result.balance }, ms: result.ms }
    }
    if (service === 'minimax') {
      const result = await fetchMinimaxQuota({
        apiKey: key.apiKey,
        region: this.settings.minimaxRegion,
        timeoutMs: this.settings.timeoutMs,
        fetchImpl: this.fetchImpl
      })
      return { data: result.quota, ms: result.ms }
    }
    const result = await fetchAliyunBalance({
      accessKeyId: key.accessKeyId,
      accessKeySecret: key.accessKeySecret,
      endpoint: this.settings.aliyunEndpoint,
      timeoutMs: this.settings.timeoutMs,
      fetchImpl: this.fetchImpl,
      now: this.now()
    })
    return { data: { balance: result.balance, requestId: result.requestId }, ms: result.ms }
  }

  /**
   * Refresh one provider, or every configured provider when no service is given.
   * @param service - optional provider id.
   * @returns the refreshed snapshot.
   */
  async refresh(service) {
    if (this.disposed) return this.snapshot()
    if (isServiceKey(service)) {
      await this.refreshService(service)
      return this.snapshot()
    }
    await Promise.all([
      ...SERVICES.map((name) => this.refreshService(name)),
      ...this.customSources.map((source) => this.refreshCustom(source.id))
    ])
    return this.snapshot()
  }

  /**
   * The "测试连接" action: a real probe (not the cache), reported with latency.
   * @param service - provider id.
   * @returns `{ service, ok, ms, error, card, snapshot }`.
   */
  async testConnection(service) {
    if (typeof service === 'string' && service.startsWith('custom-')) {
      const source = this.customSources.find((entry) => entry.id === service)
      if (source === undefined) {
        return {
          service,
          ok: false,
          ms: null,
          error: { code: 'custom-missing', message: 'the custom source no longer exists' },
          card: null,
          snapshot: this.snapshot()
        }
      }
      await this.refreshCustom(service)
      const customSnapshot = this.snapshot()
      const customCard = customSnapshot.cards.find((entry) => entry.id === service)
      const customAttempt = this.customStates.get(service)?.attempt ?? null
      return {
        service,
        ok: customAttempt !== null && customAttempt.ok === true,
        ms: customAttempt?.ms ?? null,
        error: customCard?.error ?? null,
        card: customCard,
        snapshot: customSnapshot
      }
    }
    const key = this.keyInfo(service)
    if (!key.configured) {
      return {
        service,
        ok: false,
        ms: null,
        error: { code: 'no-key', message: `no credential is configured for ${service}` },
        card: this.cardFor(service),
        snapshot: this.snapshot()
      }
    }
    await this.refreshService(service)
    const snapshot = this.snapshot()
    const card = snapshot.cards.find((entry) => entry.id === service)
    const attempt = this.states[service].attempt
    return {
      service,
      ok: attempt !== null && attempt.ok === true,
      ms: attempt?.ms ?? null,
      error: card?.error ?? null,
      card,
      snapshot
    }
  }

  /**
   * Session-level usage for the current month. The scan runs synchronously on
   * the Host, so its result is cached for {@link SESSION_TTL_MS}.
   * @param options - `{ refresh?: boolean }`.
   */
  async sessions(options = {}) {
    const now = Date.now()
    const cached = this.sessionCache.data
    if (options.refresh !== true && cached !== null && now - this.sessionCache.at < this.sessionTtlMs) {
      return { ...cached, cached: true, ageMs: now - this.sessionCache.at }
    }
    const data = scanSessions({
      root: join(this.home, 'sessions'),
      now: this.now()
    })
    this.sessionCache = { at: now, data }
    return { ...data, cached: false, ageMs: 0 }
  }

  /**
   * Update the alert settings only.
   * @param patch - `{ enabled?, desktop?, thresholds? }`.
   * @returns `{ settings, snapshot }`.
   */
  async updateAlerts(patch) {
    const next = normalizeAlerts(this.settings.alerts)
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.desktop === 'boolean') next.desktop = patch.desktop
    if (patch.thresholds !== undefined) {
      if (patch.thresholds === null || typeof patch.thresholds !== 'object' || Array.isArray(patch.thresholds)) {
        throw new HttpError(400, 'invalid-threshold', 'thresholds must be an object')
      }
      const thresholds = {}
      for (const [key, value] of Object.entries(patch.thresholds)) {
        if (!isService(key) && !this.customSources.some((source) => source.id === key)) {
          throw new HttpError(400, 'invalid-threshold', `unknown threshold target "${key}"`)
        }
        const numeric = Number(value)
        if (!Number.isFinite(numeric) || numeric < 0) {
          throw new HttpError(400, 'invalid-threshold', `threshold for "${key}" is not a non-negative number`)
        }
        if (numeric > 0) thresholds[key] = Math.round(numeric * 100) / 100
      }
      next.thresholds = thresholds
    }
    this.settings = { ...this.settings, alerts: next }
    await saveSettings(this.home, this.settings)
    this.settings = loadSettings(this.home)
    return { settings: this.publicSettings(), snapshot: this.snapshot() }
  }

  /**
   * Create or update one custom source.
   * @param patch - `{ id?, name, url, valuePath, currency?, headers? }`.
   * @returns `{ source, settings, snapshot }`.
   */
  async saveCustomSource(patch) {
    if (patch === null || typeof patch !== 'object') {
      throw new HttpError(400, 'bad-request', 'custom source patch must be an object')
    }
    const existing = patch.id === undefined
      ? undefined
      : this.customSources.find((source) => source.id === patch.id)
    if (patch.id !== undefined && existing === undefined) {
      throw new HttpError(404, 'custom-not-found', 'the custom source no longer exists')
    }
    if (existing === undefined && this.customSources.length >= MAX_CUSTOM_SOURCES) {
      throw new HttpError(409, 'custom-limit', `at most ${MAX_CUSTOM_SOURCES} custom sources are allowed`)
    }
    const built = buildCustomSource(patch, existing, this.customSources)
    if (!built.ok) throw new HttpError(400, built.code, 'the custom source is not usable')
    const next = existing === undefined
      ? [...this.customSources, built.source]
      : this.customSources.map((source) => (source.id === existing.id ? built.source : source))
    try {
      await saveCustomSources(this.home, next)
    } catch (error) {
      throw new HttpError(500, 'custom-write', `the custom source could not be saved: ${String(error?.message ?? error)}`)
    }
    this.customSources = next
    if (existing === undefined) {
      this.customStates.set(built.source.id, { cache: null, attempt: null, inflight: null })
    } else if (customFingerprint(existing) !== customFingerprint(built.source)) {
      this.customStates.set(existing.id, { cache: null, attempt: null, inflight: null })
      await clearCustomCache(this.home, existing.id).catch(() => {})
    }
    return { source: publicCustomSource(built.source), settings: this.publicSettings(), snapshot: this.snapshot() }
  }

  /**
   * Delete one custom source, its cache and its alert threshold.
   * @param id - the source id.
   * @returns `{ settings, snapshot }`.
   */
  async deleteCustomSource(id) {
    const existing = this.customSources.find((source) => source.id === id)
    if (existing === undefined) throw new HttpError(404, 'custom-not-found', 'the custom source no longer exists')
    const next = this.customSources.filter((source) => source.id !== id)
    await saveCustomSources(this.home, next)
    this.customSources = next
    this.customStates.delete(id)
    await clearCustomCache(this.home, id).catch(() => {})
    const alerts = normalizeAlerts(this.settings.alerts)
    if (alerts.thresholds[id] !== undefined) {
      delete alerts.thresholds[id]
      this.settings = { ...this.settings, alerts }
      await saveSettings(this.home, this.settings)
      this.settings = loadSettings(this.home)
    }
    return { settings: this.publicSettings(), snapshot: this.snapshot() }
  }

  /**
   * Apply a per-service settings patch. Changing credentials or an endpoint
   * drops that provider's cache: it belonged to the previous account.
   * @param patch - `{ service?, clear?, ...fields }`.
   * @returns `{ settings, snapshot }`.
   */
  async updateSettings(patch) {
    if (patch === null || typeof patch !== 'object') {
      throw new HttpError(400, 'bad-request', 'settings patch must be an object')
    }
    if (patch.service === 'alerts') return this.updateAlerts(patch)
    if (patch.service !== undefined && !isService(patch.service)) {
      throw new HttpError(400, 'bad-service', 'unknown service')
    }
    const service = isService(patch.service) ? patch.service : 'deepseek'
    const key = this.keyInfo(service)
    let settingsChanged = false
    let cacheChanged = false

    if (patch.clear === true) {
      if (key.source === 'env') throw new HttpError(409, 'key-from-env', `the ${service} credential is set by the environment`)
      const cleared = service === 'aliyun'
        ? { accessKeyId: '', accessKeySecret: '' }
        : { apiKey: '' }
      await updateServiceCredentials(this.home, service, cleared)
      cacheChanged = true
    } else if (service === 'deepseek') {
      if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
        const valid = validateApiKey(patch.apiKey)
        if (!valid.ok) throw new HttpError(400, valid.code, 'the API key is not usable')
        await updateServiceCredentials(this.home, service, { apiKey: valid.value })
        cacheChanged = true
      }
      if (typeof patch.baseUrl === 'string') {
        const valid = validateBaseUrl(patch.baseUrl)
        if (!valid.ok) throw new HttpError(400, valid.code, 'the API root is not usable')
        if (valid.value !== this.settings.baseUrl) {
          this.settings = { ...this.settings, baseUrl: valid.value }
          settingsChanged = true
          cacheChanged = true
        }
      }
    } else if (service === 'minimax') {
      if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') {
        const valid = validateApiKey(patch.apiKey)
        if (!valid.ok) throw new HttpError(400, valid.code, 'the MiniMax key is not usable')
        await updateServiceCredentials(this.home, service, { apiKey: valid.value })
        cacheChanged = true
      }
      if (patch.region !== undefined) {
        const region = normalizeMinimaxRegion(patch.region)
        if (region !== this.settings.minimaxRegion) {
          this.settings = { ...this.settings, minimaxRegion: region }
          settingsChanged = true
          cacheChanged = true
        }
      }
    } else {
      const id = patch.accessKeyId === undefined ? undefined : validateAccessKeyId(patch.accessKeyId)
      const secret = patch.accessKeySecret === undefined ? undefined : validateAccessKeySecret(patch.accessKeySecret)
      if (id !== undefined && !id.ok) throw new HttpError(400, id.code, 'the AccessKey ID is not usable')
      if (secret !== undefined && !secret.ok) throw new HttpError(400, secret.code, 'the AccessKey Secret is not usable')
      if ((id !== undefined && id.value !== '') || (secret !== undefined && secret.value !== '')) {
        await updateServiceCredentials(this.home, service, {
          ...(id !== undefined && id.value !== '' ? { accessKeyId: id.value } : {}),
          ...(secret !== undefined && secret.value !== '' ? { accessKeySecret: secret.value } : {})
        })
        cacheChanged = true
      }
      if (typeof patch.endpoint === 'string') {
        const endpoint = normalizeAliyunEndpoint(patch.endpoint)
        if (endpoint !== this.settings.aliyunEndpoint) {
          this.settings = { ...this.settings, aliyunEndpoint: endpoint }
          settingsChanged = true
          cacheChanged = true
        }
      }
    }

    if (patch.timeoutMs !== undefined) {
      const timeoutMs = normalizeTimeout(patch.timeoutMs)
      if (timeoutMs !== this.settings.timeoutMs) {
        this.settings = { ...this.settings, timeoutMs }
        settingsChanged = true
      }
    }

    if (settingsChanged) {
      await saveSettings(this.home, this.settings)
      this.settings = loadSettings(this.home)
    }
    if (cacheChanged) {
      this.states[service].cache = null
      this.states[service].attempt = null
      await clearProviderCache(this.home, service)
    }
    return { settings: this.publicSettings(), snapshot: this.snapshot() }
  }

  /** Release the engine. No timers or sockets are held. */
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
            const payload = await readJsonBody(request)
            switch (method) {
              case 'snapshot':
              case 'settings.get':
                writeJson(response, 200, { ok: true, snapshot: engine.snapshot() })
                return
              case 'refresh': {
                if (payload.service !== undefined && !isServiceKey(payload.service)) {
                  throw new HttpError(400, 'bad-service', 'unknown service')
                }
                writeJson(response, 200, { ok: true, snapshot: await engine.refresh(payload.service) })
                return
              }
              case 'test': {
                const service = payload.service ?? 'deepseek'
                if (!isServiceKey(service)) throw new HttpError(400, 'bad-service', 'unknown service')
                writeJson(response, 200, { ok: true, result: await engine.testConnection(service) })
                return
              }
              case 'settings.update': {
                const result = await engine.updateSettings(payload)
                writeJson(response, 200, { ok: true, settings: result.settings, snapshot: result.snapshot })
                return
              }
              case 'sessions': {
                writeJson(response, 200, { ok: true, sessions: await engine.sessions({ refresh: payload.refresh === true }) })
                return
              }
              case 'custom.save': {
                const result = await engine.saveCustomSource(payload)
                writeJson(response, 200, { ok: true, ...result })
                return
              }
              case 'custom.delete': {
                if (typeof payload.id !== 'string' || payload.id === '') {
                  throw new HttpError(400, 'bad-request', 'a custom source id is required')
                }
                const result = await engine.deleteCustomSource(payload.id)
                writeJson(response, 200, { ok: true, ...result })
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
      logger.warn?.(`usage-panel: could not mount ${ROUTE_PREFIX}: ${String(error?.message ?? error)}`)
      return () => {}
    }
  }, 'usage-panel: routes')

  const names = SERVICES.filter((service) => engine.keyInfo(service).configured).map((service) => SERVICE_NAMES[service])
  logger.info?.(`usage-panel: mounted ${ROUTE_PREFIX} (configured: ${names.length === 0 ? 'none' : names.join(', ')}; ledger: ${ledgerPath(engine.home)})`)
}
