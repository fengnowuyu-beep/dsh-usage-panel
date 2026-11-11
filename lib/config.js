/**
 * dsh-usage-panel — persisted configuration and credential handling.
 *
 * The plugin keeps two documents under `<DSH_HOME>/usage-panel/`:
 *
 *  - `settings.json`     — non-secret preferences (base URL, timeout, currency);
 *  - `credentials.json`  — the DeepSeek API key. Written private (0600), read
 *    only by the Host half, and never projected to the browser: the page only
 *    ever sees {@link maskKey}'s output.
 *
 * Everything in this module is failure-tolerant. A missing, truncated or
 * hostile document falls back to the defaults instead of taking the plugin —
 * or DSH — down. Only writes fail loudly, because the settings form has to be
 * able to say that a save did not stick.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { normalizeCustomSource } from './custom.js'

/** The one interface timeout the contract allows, in milliseconds. */
export const MAX_TIMEOUT_MS = 5000

/** The lowest timeout the form accepts; below this a slow provider always fails. */
export const MIN_TIMEOUT_MS = 1000

/** Non-secret defaults. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** DeepSeek API root; `/user/balance` is appended. */
  baseUrl: 'https://api.deepseek.com',
  /** Hard cap per HTTP request, in milliseconds (the brief fixes it at 5 s). */
  timeoutMs: MAX_TIMEOUT_MS,
  /** Preferred currency when the balance reply carries more than one. */
  currency: 'CNY',
  /** MiniMax Token Plan region: `cn` or `global`. */
  minimaxRegion: 'cn',
  /** Alibaba Cloud BSS endpoint host. */
  aliyunEndpoint: 'business.aliyuncs.com',
  /** Threshold alerts; thresholds are keyed by service id. */
  alerts: {
    enabled: true,
    desktop: false,
    thresholds: {}
  }
})

/** @returns the private custom-data-source document. */
export function customSourcesPath(home) {
  return join(panelDir(home), 'custom-sources.json')
}

/**
 * Read the validated custom sources (private document).
 * @param home - the harness home.
 * @returns the sources, in stored order.
 */
export function loadCustomSources(home) {
  const document = readJsonSync(customSourcesPath(home))
  const rows = document !== null && typeof document === 'object' && Array.isArray(document.sources)
    ? document.sources
    : []
  const sources = []
  const seen = new Set()
  for (const row of rows) {
    const source = normalizeCustomSource(row)
    if (source === null || seen.has(source.id)) continue
    seen.add(source.id)
    sources.push(source)
    if (sources.length >= 8) break
  }
  return sources
}

/**
 * Persist the validated custom sources.
 * @param home - the harness home.
 * @param sources - the complete list.
 */
export async function saveCustomSources(home, sources) {
  await writeJsonPrivate(customSourcesPath(home), {
    version: 1,
    updatedAt: Date.now(),
    sources
  })
}

/**
 * Normalize the alert settings without inventing thresholds.
 * @param raw - the stored alert object.
 * @returns `{ enabled, desktop, thresholds }`.
 */
export function normalizeAlerts(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const thresholds = {}
  const stored = source.thresholds !== null && typeof source.thresholds === 'object' ? source.thresholds : {}
  for (const [key, value] of Object.entries(stored)) {
    const numeric = Number(value)
    if (key === '' || !Number.isFinite(numeric) || numeric < 0) continue
    thresholds[key] = Math.round(numeric * 100) / 100
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.alerts.enabled,
    desktop: typeof source.desktop === 'boolean' ? source.desktop : DEFAULT_SETTINGS.alerts.desktop,
    thresholds
  }
}

/** @returns a normalized MiniMax region (`cn` or `global`). */
export function normalizeMinimaxRegion(value) {
  const raw = asString(value).trim().toLowerCase()
  return raw === 'global' || raw === 'io' || raw === 'intl' ? 'global' : 'cn'
}

/** @returns a bare BSS endpoint host, falling back to the official one. */
export function normalizeAliyunEndpoint(value) {
  const raw = asString(value).trim()
  if (raw === '') return DEFAULT_SETTINGS.aliyunEndpoint
  const host = raw.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return DEFAULT_SETTINGS.aliyunEndpoint
  return host
}

/**
 * Validate an AccessKey id for the form. Aliyun ids start with `LTAI`, but the
 * plugin does not enforce that: a test double or an STS token may differ.
 * @param value - the raw input.
 * @returns `{ ok: true, value }` or `{ ok: false, code }`.
 */
export function validateAccessKeyId(value) {
  const raw = asString(value).trim()
  if (raw === '') return { ok: true, value: '' }
  if (/\s/.test(raw) || raw.length < 8) return { ok: false, code: 'invalid-access-key' }
  return { ok: true, value: raw }
}

/**
 * Validate an AccessKey secret for the form.
 * @param value - the raw input.
 * @returns `{ ok: true, value }` or `{ ok: false, code }`.
 */
export function validateAccessKeySecret(value) {
  const raw = asString(value).trim()
  if (raw === '') return { ok: true, value: '' }
  if (/\s/.test(raw) || raw.length < 8) return { ok: false, code: 'invalid-access-key' }
  return { ok: true, value: raw }
}

/**
 * Resolve the harness home, matching `@deepseek-ai/dsh-home-paths` precedence:
 * an explicit configured path, then `$DSH_HOME`, then `~/.dsh`. The Host
 * process does not inherit `$DSH_HOME` (only tool shells do), so the default
 * has to be correct on its own.
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns the harness home directory.
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** @returns the plugin's own data directory. */
export function panelDir(home) {
  return join(home, 'usage-panel')
}

/** @returns the non-secret settings document. */
export function settingsPath(home) {
  return join(panelDir(home), 'settings.json')
}

/** @returns the private credential document. */
export function credentialsPath(home) {
  return join(panelDir(home), 'credentials.json')
}

/** @returns the last successful balance reply, kept across restarts. */
export function cachePath(home) {
  return join(panelDir(home), 'balance-cache.json')
}

/** @returns DSH's own local usage ledger, owned by the harness. */
export function ledgerPath(home) {
  return join(home, 'dsh-usage', 'usage-ledger.json')
}

/** Read one JSON document, returning `undefined` when it is absent or broken. */
function readJsonSync(file) {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Trim a value to a string, or return the fallback.
 * @param value - the candidate.
 * @param fallback - the value to use when `value` is not a string.
 */
function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/**
 * Normalize a base URL without ever throwing: an unusable stored value falls
 * back to the official endpoint instead of bricking the card.
 * @param value - a candidate URL.
 * @returns the normalized URL, or the default.
 */
export function normalizeBaseUrl(value) {
  const raw = asString(value).trim()
  if (raw === '') return DEFAULT_SETTINGS.baseUrl
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_SETTINGS.baseUrl
    if (url.username !== '' || url.password !== '') return DEFAULT_SETTINGS.baseUrl
    if (url.hostname === '') return DEFAULT_SETTINGS.baseUrl
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return DEFAULT_SETTINGS.baseUrl
  }
}

/**
 * Validate a URL the user typed into the form. Unlike {@link normalizeBaseUrl}
 * this reports the problem so the form can explain it.
 * @param value - the raw input.
 * @returns `{ ok: true, value }` or `{ ok: false, code }`.
 */
export function validateBaseUrl(value) {
  const raw = asString(value).trim()
  if (raw === '') return { ok: true, value: DEFAULT_SETTINGS.baseUrl }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, code: 'invalid-base-url' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, code: 'invalid-base-url' }
  if (url.username !== '' || url.password !== '') return { ok: false, code: 'invalid-base-url' }
  if (url.hostname === '') return { ok: false, code: 'invalid-base-url' }
  url.search = ''
  url.hash = ''
  return { ok: true, value: url.toString().replace(/\/+$/, '') }
}

/**
 * Validate a key pasted into the form. The prefix is deliberately not enforced
 * — DeepSeek keys start with `sk-` today, but a proxy or a test double may not.
 * @param value - the raw input.
 * @returns `{ ok: true, value }` or `{ ok: false, code }`.
 */
export function validateApiKey(value) {
  const raw = asString(value).trim()
  if (raw === '') return { ok: true, value: '' }
  if (/\s/.test(raw)) return { ok: false, code: 'invalid-key' }
  if (raw.length < 8) return { ok: false, code: 'invalid-key' }
  return { ok: true, value: raw }
}

/**
 * Clamp a timeout to the contract: at most 5 seconds, at least 1 second.
 * @param value - the candidate, possibly a string from JSON.
 * @returns the clamped integer, or the default.
 */
export function normalizeTimeout(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.timeoutMs
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(parsed)))
}

/**
 * Keep the settings document to a shape the rest of the plugin can trust.
 * @param raw - the value read from disk (possibly absent or hostile).
 * @returns a complete settings object.
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const currency = asString(source.currency, DEFAULT_SETTINGS.currency).toUpperCase()
  return {
    baseUrl: normalizeBaseUrl(source.baseUrl),
    timeoutMs: normalizeTimeout(source.timeoutMs),
    currency: currency === 'CNY' || currency === 'USD' ? currency : DEFAULT_SETTINGS.currency,
    minimaxRegion: normalizeMinimaxRegion(source.minimaxRegion),
    aliyunEndpoint: normalizeAliyunEndpoint(source.aliyunEndpoint),
    alerts: normalizeAlerts(source.alerts)
  }
}

/**
 * Read the persisted settings document.
 * @param home - the harness home.
 * @returns the normalized settings plus the file it came from.
 */
export function loadSettings(home) {
  const document = readJsonSync(settingsPath(home))
  return {
    ...normalizeSettings(document),
    savedAt: savedAtOf(document)
  }
}

/** @returns the `updatedAt` of a persisted document, or `null`. */
function savedAtOf(document) {
  const value = document !== null && typeof document === 'object' ? document.updatedAt : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Turn a key into a short, stable fingerprint. The cache stores this instead of
 * the key, so a key swap can never be served the previous account's balance.
 * @param apiKey - the plain key.
 * @returns a 16-character hex digest (empty for no key).
 */
export function keyFingerprint(apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') return ''
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
}

/**
 * Mask a key for display: `sk-…3f2a`.
 *
 * The last four characters are enough to tell two keys apart, and that is the
 * only thing the browser is ever told. A key short enough that a mask would
 * leak most of it is masked more aggressively.
 * @param apiKey - the plain key.
 * @returns the display mask (empty when no key is configured).
 */
export function maskKey(apiKey) {
  const value = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (value === '') return ''
  if (value.length <= 10) return `${value.slice(0, 1)}…${value.slice(-2)}`
  const head = value.startsWith('sk-') ? 'sk-' : value.slice(0, 3)
  return `${head}…${value.slice(-4)}`
}

/**
 * Mask an Aliyun AccessKey id, keeping the `LTAI` prefix visible.
 * @param value - the plain id.
 * @returns the display mask.
 */
export function maskAccessKeyId(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return ''
  if (raw.length <= 10) return `${raw.slice(0, 1)}…${raw.slice(-2)}`
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`
}

/** At most three additional keys per service (four including the primary). */
export const MAX_EXTRA_KEYS = 3

/** Id shape owned by extra-key management. */
const EXTRA_KEY_PATTERN = /^key-[0-9a-f]{8}$/

/** An empty, complete credential store (v3 shape). */
export function emptyCredentialStore() {
  return {
    version: 3,
    deepseek: { apiKey: '', extraKeys: [], updatedAt: null },
    minimax: { apiKey: '', extraKeys: [], updatedAt: null },
    aliyun: { accessKeyId: '', accessKeySecret: '', extraKeys: [], updatedAt: null }
  }
}

/** @returns a sanitized extra-key label, or ''. */
function normalizeExtraLabel(value) {
  const label = asString(value).trim()
  return label.length >= 1 && label.length <= 20 ? label : ''
}

/** @returns a timestamp or null. */
function timestampOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Normalize one stored extra key. Invalid rows are dropped, never guessed.
 * @param service - provider id.
 * @param raw - one stored row.
 * @returns a clean key, or null.
 */
function normalizeExtraKey(service, raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = asString(raw.id)
  const label = normalizeExtraLabel(raw.label)
  if (!EXTRA_KEY_PATTERN.test(id) || label === '') return null
  if (service === 'aliyun') {
    const accessKeyId = asString(raw.accessKeyId).trim()
    const accessKeySecret = asString(raw.accessKeySecret).trim()
    if (accessKeyId === '' || accessKeySecret === '') return null
    return { id, label, accessKeyId, accessKeySecret }
  }
  const apiKey = asString(raw.apiKey).trim()
  if (apiKey === '') return null
  return { id, label, apiKey }
}

/** @returns a fresh extra-key id. */
function generateExtraKeyId(keys) {
  const used = new Set(keys.map((key) => key.id))
  for (;;) {
    const id = `key-${randomBytes(4).toString('hex')}`
    if (!used.has(id)) return id
  }
}

/**
 * Read the whole private credential document.
 *
 * The v1 document (`{ deepseek: { apiKey } }`) is a valid prefix of v2, so an
 * existing DeepSeek key keeps working without a migration step.
 * @param home - the harness home.
 * @returns the complete v2 store.
 */
export function loadCredentialStore(home) {
  const document = readJsonSync(credentialsPath(home))
  const store = emptyCredentialStore()
  if (document === null || typeof document !== 'object') return store
  const deepseek = document.deepseek
  if (deepseek !== null && typeof deepseek === 'object') {
    store.deepseek = {
      apiKey: asString(deepseek.apiKey).trim(),
      extraKeys: (Array.isArray(deepseek.extraKeys) ? deepseek.extraKeys : [])
        .map((raw) => normalizeExtraKey('deepseek', raw))
        .filter((key) => key !== null)
        .slice(0, MAX_EXTRA_KEYS),
      updatedAt: timestampOrNull(deepseek.updatedAt)
    }
  }
  const minimax = document.minimax
  if (minimax !== null && typeof minimax === 'object') {
    store.minimax = {
      apiKey: asString(minimax.apiKey).trim(),
      extraKeys: (Array.isArray(minimax.extraKeys) ? minimax.extraKeys : [])
        .map((raw) => normalizeExtraKey('minimax', raw))
        .filter((key) => key !== null)
        .slice(0, MAX_EXTRA_KEYS),
      updatedAt: timestampOrNull(minimax.updatedAt)
    }
  }
  const aliyun = document.aliyun
  if (aliyun !== null && typeof aliyun === 'object') {
    store.aliyun = {
      accessKeyId: asString(aliyun.accessKeyId).trim(),
      accessKeySecret: asString(aliyun.accessKeySecret).trim(),
      extraKeys: (Array.isArray(aliyun.extraKeys) ? aliyun.extraKeys : [])
        .map((raw) => normalizeExtraKey('aliyun', raw))
        .filter((key) => key !== null)
        .slice(0, MAX_EXTRA_KEYS),
      updatedAt: timestampOrNull(aliyun.updatedAt)
    }
  }
  return store
}

/**
 * Persist the whole credential store.
 * @param home - the harness home.
 * @param store - the v2 store.
 */
export async function saveCredentialStore(home, store) {
  await writeJsonPrivate(credentialsPath(home), {
    version: 3,
    updatedAt: Date.now(),
    deepseek: {
      apiKey: asString(store.deepseek?.apiKey).trim(),
      extraKeys: (Array.isArray(store.deepseek?.extraKeys) ? store.deepseek.extraKeys : []).map((key) => ({
        id: asString(key.id),
        label: asString(key.label),
        apiKey: asString(key.apiKey)
      })),
      updatedAt: timestampOrNull(store.deepseek?.updatedAt)
    },
    minimax: {
      apiKey: asString(store.minimax?.apiKey).trim(),
      extraKeys: (Array.isArray(store.minimax?.extraKeys) ? store.minimax.extraKeys : []).map((key) => ({
        id: asString(key.id),
        label: asString(key.label),
        apiKey: asString(key.apiKey)
      })),
      updatedAt: timestampOrNull(store.minimax?.updatedAt)
    },
    aliyun: {
      accessKeyId: asString(store.aliyun?.accessKeyId).trim(),
      accessKeySecret: asString(store.aliyun?.accessKeySecret).trim(),
      extraKeys: (Array.isArray(store.aliyun?.extraKeys) ? store.aliyun.extraKeys : []).map((key) => ({
        id: asString(key.id),
        label: asString(key.label),
        accessKeyId: asString(key.accessKeyId),
        accessKeySecret: asString(key.accessKeySecret)
      })),
      updatedAt: timestampOrNull(store.aliyun?.updatedAt)
    }
  })
}

/**
 * Replace one service's credentials without touching the other services.
 * @param home - the harness home.
 * @param service - `deepseek` | `minimax` | `aliyun`.
 * @param values - the fields to set; omitted fields are preserved.
 * @returns the updated store.
 */
export async function updateServiceCredentials(home, service, values) {
  const store = loadCredentialStore(home)
  const at = Date.now()
  if (service === 'deepseek') {
    store.deepseek = {
      apiKey: asString(values?.apiKey).trim(),
      extraKeys: store.deepseek.extraKeys,
      updatedAt: at
    }
  } else if (service === 'minimax') {
    store.minimax = {
      apiKey: asString(values?.apiKey).trim(),
      extraKeys: store.minimax.extraKeys,
      updatedAt: at
    }
  } else if (service === 'aliyun') {
    store.aliyun = {
      accessKeyId: values?.accessKeyId === undefined
        ? store.aliyun.accessKeyId
        : asString(values.accessKeyId).trim(),
      accessKeySecret: values?.accessKeySecret === undefined
        ? store.aliyun.accessKeySecret
        : asString(values.accessKeySecret).trim(),
      extraKeys: store.aliyun.extraKeys,
      updatedAt: at
    }
  } else {
    throw new Error(`unknown service "${String(service)}"`)
  }
  await saveCredentialStore(home, store)
  return store
}

/**
 * Validate one proposed extra key without writing it.
 * @param service - provider id.
 * @param values - `{ label, apiKey }` or `{ label, accessKeyId, accessKeySecret }`.
 * @returns `{ ok: true, key }` or `{ ok: false, code }`.
 */
export function validateExtraKey(service, values) {
  const label = normalizeExtraLabel(values?.label)
  if (label === '') return { ok: false, code: 'invalid-key-label' }
  if (service === 'aliyun') {
    const accessKeyId = validateAccessKeyId(values?.accessKeyId)
    if (!accessKeyId.ok) return accessKeyId
    const accessKeySecret = validateAccessKeySecret(values?.accessKeySecret)
    if (!accessKeySecret.ok) return accessKeySecret
    return {
      ok: true,
      key: { label, accessKeyId: accessKeyId.value, accessKeySecret: accessKeySecret.value }
    }
  }
  const apiKey = validateApiKey(values?.apiKey)
  if (!apiKey.ok) return apiKey
  return { ok: true, key: { label, apiKey: apiKey.value } }
}

/**
 * Append one extra key to a service.
 * @param home - the harness home.
 * @param service - provider id.
 * @param values - key fields plus a label.
 * @returns `{ ok: true, key }` or `{ ok: false, code }`.
 */
export async function addExtraKey(home, service, values) {
  const store = loadCredentialStore(home)
  const existing = store[service]?.extraKeys
  if (!Array.isArray(existing)) return { ok: false, code: 'bad-service' }
  const valid = validateExtraKey(service, values)
  if (!valid.ok) return valid
  if (existing.length >= MAX_EXTRA_KEYS) return { ok: false, code: 'key-limit' }
  const key = { id: generateExtraKeyId(existing), ...valid.key }
  store[service].extraKeys = [...existing, key]
  await saveCredentialStore(home, store)
  return { ok: true, key }
}

/**
 * Remove one extra key.
 * @param home - the harness home.
 * @param service - provider id.
 * @param id - the extra key id.
 * @returns `{ ok: true }` or `{ ok: false, code }`.
 */
export async function deleteExtraKey(home, service, id) {
  const store = loadCredentialStore(home)
  const existing = store[service]?.extraKeys
  if (!Array.isArray(existing)) return { ok: false, code: 'bad-service' }
  if (!existing.some((key) => key.id === id)) return { ok: false, code: 'key-not-found' }
  store[service].extraKeys = existing.filter((key) => key.id !== id)
  await saveCredentialStore(home, store)
  return { ok: true }
}

/** @returns the extra keys with secrets (Host-only). */
export function loadExtraKeys(home, service) {
  return loadCredentialStore(home)[service]?.extraKeys ?? []
}

/**
 * Legacy view: the DeepSeek credential only.
 * @param home - the harness home.
 * @returns `{ apiKey, updatedAt }`.
 */
export function loadCredentials(home) {
  const store = loadCredentialStore(home)
  return { apiKey: store.deepseek.apiKey, updatedAt: store.deepseek.updatedAt }
}

/**
 * Resolve the DeepSeek key: the plugin's document first, then
 * `DEEPSEEK_API_KEY` as an operator convenience.
 * @param home - the harness home.
 * @param env - the environment (injected for tests).
 * @returns `{ apiKey, source, updatedAt }` where source is `file`, `env` or `none`.
 */
export function resolveApiKey(home, env = process.env) {
  const stored = loadCredentialStore(home).deepseek
  if (stored.apiKey !== '') return { apiKey: stored.apiKey, source: 'file', updatedAt: stored.updatedAt }
  const fromEnv = typeof env?.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : ''
  if (fromEnv !== '') return { apiKey: fromEnv, source: 'env', updatedAt: null }
  return { apiKey: '', source: 'none', updatedAt: null }
}

/**
 * Resolve the MiniMax key: document first, then `MINIMAX_API_KEY`.
 * @param home - the harness home.
 * @param env - the environment.
 */
export function resolveMinimaxKey(home, env = process.env) {
  const stored = loadCredentialStore(home).minimax
  if (stored.apiKey !== '') return { apiKey: stored.apiKey, source: 'file', updatedAt: stored.updatedAt }
  const fromEnv = typeof env?.MINIMAX_API_KEY === 'string' ? env.MINIMAX_API_KEY.trim() : ''
  if (fromEnv !== '') return { apiKey: fromEnv, source: 'env', updatedAt: null }
  return { apiKey: '', source: 'none', updatedAt: null }
}

/**
 * Resolve the Aliyun RAM credentials: document first, then the environment.
 * Both halves are taken from the same source so a mismatched pair is impossible.
 * @param home - the harness home.
 * @param env - the environment.
 */
export function resolveAliyunKey(home, env = process.env) {
  const stored = loadCredentialStore(home).aliyun
  if (stored.accessKeyId !== '' && stored.accessKeySecret !== '') {
    return {
      accessKeyId: stored.accessKeyId,
      accessKeySecret: stored.accessKeySecret,
      source: 'file',
      updatedAt: stored.updatedAt
    }
  }
  const id = typeof env?.ALIYUN_ACCESS_KEY_ID === 'string' ? env.ALIYUN_ACCESS_KEY_ID.trim() : ''
  const secret = typeof env?.ALIYUN_ACCESS_KEY_SECRET === 'string' ? env.ALIYUN_ACCESS_KEY_SECRET.trim() : ''
  if (id !== '' && secret !== '') {
    return { accessKeyId: id, accessKeySecret: secret, source: 'env', updatedAt: null }
  }
  return { accessKeyId: '', accessKeySecret: '', source: 'none', updatedAt: null }
}

/** Cache entries keyed by service. */
const CACHE_SERVICES = ['deepseek', 'minimax', 'aliyun']

/** @returns the raw cache document (possibly empty). */
function readCacheDocument(home) {
  const document = readJsonSync(cachePath(home))
  return document !== null && typeof document === 'object' ? document : {}
}

/** @returns true when the raw cache document still has any entry. */
function hasCacheEntries(document) {
  if (CACHE_SERVICES.some((service) => document[service] !== undefined)) return true
  const custom = document.custom
  if (custom !== null && typeof custom === 'object' && Object.keys(custom).length > 0) return true
  const extra = document.extraKeys
  if (extra !== null && typeof extra === 'object') {
    return Object.values(extra).some((keys) => keys !== null && typeof keys === 'object' && Object.keys(keys).length > 0)
  }
  return false
}

/**
 * Read the per-service cache document.
 *
 * v1 stored only `{ deepseek: { balance, fetchedAt, fingerprint } }`; the
 * reader accepts that shape and exposes it as the deepseek entry, so an upgrade
 * keeps the last good balance instead of showing an empty card once.
 * @param home - the harness home.
 * @returns `{ deepseek, minimax, aliyun }` entries (each `null` when absent).
 */
export function loadProviderCache(home) {
  const document = readCacheDocument(home)
  const result = { deepseek: null, minimax: null, aliyun: null }
  for (const service of CACHE_SERVICES) {
    const entry = document[service]
    if (entry === null || typeof entry !== 'object') continue
    const data = entry.data !== undefined ? entry.data : (service === 'deepseek' ? entry.balance : undefined)
    if (data === null || data === undefined || typeof data !== 'object') continue
    const fetchedAt = Number(entry.fetchedAt)
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) continue
    result[service] = {
      data,
      fetchedAt,
      fingerprint: asString(entry.fingerprint)
    }
  }
  return result
}

/**
 * Read cached custom-source replies.
 * @param home - the harness home.
 * @returns a map of `sourceId → { data, fetchedAt, fingerprint }`.
 */
export function loadCustomCache(home) {
  const document = readCacheDocument(home)
  const stored = document.custom
  const result = {}
  if (stored === null || typeof stored !== 'object') return result
  for (const [id, entry] of Object.entries(stored)) {
    if (entry === null || typeof entry !== 'object') continue
    const data = entry.data
    if (data === null || typeof data !== 'object') continue
    const fetchedAt = Number(entry.fetchedAt)
    if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) continue
    result[id] = { data, fetchedAt, fingerprint: asString(entry.fingerprint) }
  }
  return result
}

/**
 * Legacy view: the DeepSeek balance entry only.
 * @param home - the harness home.
 * @returns `{ balance, fetchedAt, fingerprint }` or `null`.
 */
export function loadBalanceCache(home) {
  const entry = loadProviderCache(home).deepseek
  if (entry === null) return null
  return { balance: entry.data, fetchedAt: entry.fetchedAt, fingerprint: entry.fingerprint }
}

/**
 * Read the persisted settings without a second disk read for `savedAt`.
 * @param home - the harness home.
 */
export function readSettingsDocument(home) {
  return readJsonSync(settingsPath(home))
}

/**
 * Write a JSON document atomically and privately: a temp file in the same
 * directory, then a rename. A crash leaves the previous document intact.
 * @param file - the destination path.
 * @param value - the JSON-serializable value.
 */
export async function writeJsonPrivate(file, value) {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })
  const temp = join(directory, `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  const body = `${JSON.stringify(value, null, 2)}\n`
  try {
    await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
    // Windows ignores the mode on create; chmod is a no-op there but keeps the
    // intent explicit on POSIX where the file really is readable by others.
    await chmod(temp, 0o600).catch(() => {})
    await rename(temp, file)
    await chmod(file, 0o600).catch(() => {})
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Persist the non-secret settings.
 * @param home - the harness home.
 * @param settings - the complete normalized settings.
 */
export async function saveSettings(home, settings) {
  const document = {
    version: 2,
    updatedAt: Date.now(),
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    currency: settings.currency,
    minimaxRegion: settings.minimaxRegion,
    aliyunEndpoint: settings.aliyunEndpoint,
    alerts: normalizeAlerts(settings.alerts)
  }
  await writeJsonPrivate(settingsPath(home), document)
  return document
}

/**
 * Persist (or clear) the DeepSeek key, preserving the other services.
 * @param home - the harness home.
 * @param apiKey - the plain key; an empty string removes the entry.
 */
export async function saveCredentials(home, apiKey) {
  return updateServiceCredentials(home, 'deepseek', { apiKey })
}

/**
 * Persist one service's last successful reply, preserving the others.
 * @param home - the harness home.
 * @param service - `deepseek` | `minimax` | `aliyun`.
 * @param entry - `{ data, fetchedAt, fingerprint }`.
 */
export async function saveProviderCache(home, service, entry) {
  if (!CACHE_SERVICES.includes(service)) throw new Error(`unknown cache service "${String(service)}"`)
  const document = readCacheDocument(home)
  document.version = 2
  document[service] = entry
  await writeJsonPrivate(cachePath(home), document)
}

/**
 * Forget one service's cached reply. Used when its key or endpoint changes.
 * @param home - the harness home.
 * @param service - `deepseek` | `minimax` | `aliyun`.
 */
export async function clearProviderCache(home, service) {
  const document = readCacheDocument(home)
  delete document[service]
  if (!hasCacheEntries(document)) {
    await rm(cachePath(home), { force: true }).catch(() => {})
    return
  }
  await writeJsonPrivate(cachePath(home), document)
}

/**
 * Persist one custom source's reply, preserving built-in and sibling entries.
 * @param home - the harness home.
 * @param id - the custom source id.
 * @param entry - `{ data, fetchedAt, fingerprint }`.
 */
export async function saveCustomCache(home, id, entry) {
  const document = readCacheDocument(home)
  document.version = 2
  if (document.custom === null || typeof document.custom !== 'object') document.custom = {}
  document.custom[id] = entry
  await writeJsonPrivate(cachePath(home), document)
}

/**
 * Forget one custom source's cached reply.
 * @param home - the harness home.
 * @param id - the custom source id.
 */
export async function clearCustomCache(home, id) {
  const document = readCacheDocument(home)
  if (document.custom === null || typeof document.custom !== 'object') return
  delete document.custom[id]
  if (Object.keys(document.custom).length === 0) delete document.custom
  if (!hasCacheEntries(document)) {
    await rm(cachePath(home), { force: true }).catch(() => {})
    return
  }
  await writeJsonPrivate(cachePath(home), document)
}

/**
 * Read cached extra-key replies.
 * @param home - the harness home.
 * @returns `{ [service]: { [keyId]: { data, fetchedAt, fingerprint } } }`.
 */
export function loadExtraKeyCache(home) {
  const document = readCacheDocument(home)
  const stored = document.extraKeys
  const result = {}
  if (stored === null || typeof stored !== 'object') return result
  for (const service of CACHE_SERVICES) {
    const keys = stored[service]
    if (keys === null || typeof keys !== 'object') continue
    result[service] = {}
    for (const [id, entry] of Object.entries(keys)) {
      if (entry === null || typeof entry !== 'object') continue
      const data = entry.data
      if (data === null || typeof data !== 'object') continue
      const fetchedAt = Number(entry.fetchedAt)
      if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) continue
      result[service][id] = { data, fetchedAt, fingerprint: asString(entry.fingerprint) }
    }
  }
  return result
}

/**
 * Persist one extra key's reply, preserving all sibling entries.
 * @param home - the harness home.
 * @param service - provider id.
 * @param keyId - the extra key id.
 * @param entry - `{ data, fetchedAt, fingerprint }`.
 */
export async function saveExtraKeyCache(home, service, keyId, entry) {
  const document = readCacheDocument(home)
  document.version = 2
  if (document.extraKeys === null || typeof document.extraKeys !== 'object') document.extraKeys = {}
  if (document.extraKeys[service] === null || typeof document.extraKeys[service] !== 'object') {
    document.extraKeys[service] = {}
  }
  document.extraKeys[service][keyId] = entry
  await writeJsonPrivate(cachePath(home), document)
}

/**
 * Forget all cached replies for one service's extra keys.
 * @param home - the harness home.
 * @param service - provider id.
 */
export async function clearExtraKeyCache(home, service) {
  const document = readCacheDocument(home)
  if (document.extraKeys === null || typeof document.extraKeys !== 'object') return
  delete document.extraKeys[service]
  if (Object.keys(document.extraKeys).length === 0) delete document.extraKeys
  if (!hasCacheEntries(document)) {
    await rm(cachePath(home), { force: true }).catch(() => {})
    return
  }
  await writeJsonPrivate(cachePath(home), document)
}

/**
 * Persist the DeepSeek balance reply (legacy call sites).
 * @param home - the harness home.
 * @param entry - `{ balance, fetchedAt, fingerprint }`.
 */
export async function saveBalanceCache(home, entry) {
  await saveProviderCache(home, 'deepseek', {
    data: entry.balance,
    fetchedAt: entry.fetchedAt,
    fingerprint: entry.fingerprint
  })
}

/**
 * Forget the cached DeepSeek balance (legacy call sites).
 * @param home - the harness home.
 */
export async function clearBalanceCache(home) {
  await clearProviderCache(home, 'deepseek')
}

/** @returns the private credential document path, for the README and tests. */
export function credentialDisplayPath() {
  return join('~', '.dsh', 'usage-panel', 'credentials.json')
}
