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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
  currency: 'CNY'
})

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
    currency: currency === 'CNY' || currency === 'USD' ? currency : DEFAULT_SETTINGS.currency
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
 * Read the private credential document.
 * @param home - the harness home.
 * @returns `{ apiKey, updatedAt }`; an unreadable document reads as "no key".
 */
export function loadCredentials(home) {
  const document = readJsonSync(credentialsPath(home))
  const deepseek = document !== null && typeof document === 'object' ? document.deepseek : undefined
  const apiKey = deepseek !== null && typeof deepseek === 'object' ? asString(deepseek.apiKey).trim() : ''
  const updatedAt = deepseek !== null && typeof deepseek === 'object' ? deepseek.updatedAt : undefined
  return {
    apiKey,
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null
  }
}

/**
 * Resolve the key actually in force: the plugin's own document first, then the
 * `DEEPSEEK_API_KEY` environment variable as an operator convenience.
 * @param home - the harness home.
 * @param env - the environment (injected for tests).
 * @returns `{ apiKey, source }` where source is `file`, `env` or `none`.
 */
export function resolveApiKey(home, env = process.env) {
  const stored = loadCredentials(home)
  if (stored.apiKey !== '') return { apiKey: stored.apiKey, source: 'file', updatedAt: stored.updatedAt }
  const fromEnv = typeof env?.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : ''
  if (fromEnv !== '') return { apiKey: fromEnv, source: 'env', updatedAt: null }
  return { apiKey: '', source: 'none', updatedAt: null }
}

/**
 * Read the last successful balance reply.
 * @param home - the harness home.
 * @returns `{ balance, fetchedAt, fingerprint }` or `null`.
 */
export function loadBalanceCache(home) {
  const document = readJsonSync(cachePath(home))
  const entry = document !== null && typeof document === 'object' ? document.deepseek : undefined
  if (entry === null || typeof entry !== 'object') return null
  const balance = entry.balance
  if (balance === null || typeof balance !== 'object') return null
  const fetchedAt = Number(entry.fetchedAt)
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
  return {
    balance,
    fetchedAt,
    fingerprint: asString(entry.fingerprint)
  }
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
    version: 1,
    updatedAt: Date.now(),
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    currency: settings.currency
  }
  await writeJsonPrivate(settingsPath(home), document)
  return document
}

/**
 * Persist (or clear) the DeepSeek key.
 * @param home - the harness home.
 * @param apiKey - the plain key; an empty string removes the document entry.
 */
export async function saveCredentials(home, apiKey) {
  const document = {
    version: 1,
    updatedAt: Date.now(),
    deepseek: {
      apiKey,
      updatedAt: Date.now()
    }
  }
  await writeJsonPrivate(credentialsPath(home), document)
  return document
}

/**
 * Persist the last successful balance reply.
 * @param home - the harness home.
 * @param entry - `{ balance, fetchedAt, fingerprint }`.
 */
export async function saveBalanceCache(home, entry) {
  await writeJsonPrivate(cachePath(home), { version: 1, deepseek: entry })
}

/**
 * Forget the cached balance. Used when the key or the endpoint changes, where
 * the previous account's figures would be actively misleading.
 * @param home - the harness home.
 */
export async function clearBalanceCache(home) {
  await rm(cachePath(home), { force: true }).catch(() => {})
}

/** @returns the private credential document path, for the README and tests. */
export function credentialDisplayPath() {
  return join('~', '.dsh', 'usage-panel', 'credentials.json')
}
