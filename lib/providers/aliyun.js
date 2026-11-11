/**
 * Alibaba Cloud BSS OpenAPI balance adapter.
 *
 * API: `QueryAccountBalance` (BssOpenApi 2017-12-14), endpoint
 * `business.aliyuncs.com`, no request-specific parameters. The account must use
 * a RAM sub-account with `bss:DescribeAcccount`; the plugin never asks for the
 * primary account's AccessKey.
 *
 * Authentication is classic RPC HMAC-SHA1:
 *   StringToSign = GET&%2F&percentEncode(sorted query)
 *   Signature    = Base64(HMAC-SHA1(secret + "&", StringToSign))
 * The secret only ever feeds the HMAC; it is never placed in the URL or headers.
 */
import { createHmac, randomUUID } from 'node:crypto'

import { RemoteError, requestJson } from '../remote.js'

/** The default BSS endpoint. */
export const DEFAULT_ENDPOINT = 'business.aliyuncs.com'

/** RPC API identity. */
export const API_VERSION = '2017-12-14'
export const API_ACTION = 'QueryAccountBalance'

/**
 * Normalize an endpoint to a bare host. Scheme, path and trailing slashes are
 * dropped; an unusable value falls back to the official endpoint.
 * @param value - the configured endpoint.
 * @returns the host used in the request URL.
 */
export function normalizeEndpoint(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return DEFAULT_ENDPOINT
  const host = raw
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return DEFAULT_ENDPOINT
  return host
}

/**
 * Aliyun's RFC 3986 percent-encoding (`encodeURIComponent` plus four extras).
 * @param value - raw string.
 * @returns the encoded string.
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}

/**
 * Build the canonical query string (sorted by key, RFC 3986 encoded).
 * @param params - the query parameters, including the signature.
 */
export function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')
}

/**
 * Sign one RPC request.
 * @param options - `{ params, secret }`; the signature is added to `params`.
 * @returns the base64 signature.
 */
export function signRpc(options) {
  const { params, secret } = options
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}`
  return createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64')
}

/**
 * Build the full public parameter set for one balance request.
 * @param options - `{ accessKeyId, secret, nonce, timestamp }`.
 * @returns `{ params, query, stringToSign }`.
 */
export function buildRpcQuery(options) {
  const params = {
    AccessKeyId: options.accessKeyId,
    Action: API_ACTION,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: options.nonce,
    SignatureVersion: '1.0',
    Timestamp: options.timestamp,
    Version: API_VERSION
  }
  const signature = signRpc({ params, secret: options.secret })
  const signed = { ...params, Signature: signature }
  return { params: signed, query: canonicalQuery(signed), stringToSign: `GET&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}` }
}

/** @returns a finite number, or null. */
function numberish(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Map an Aliyun error body/status onto a stable code.
 * @param status - the HTTP status.
 * @param body - the parsed response body.
 * @returns a {@link RemoteError}.
 */
export function aliyunError(status, body) {
  const code = typeof body?.Code === 'string' ? body.Code : ''
  const message = typeof body?.Message === 'string' ? body.Message : ''
  if (status >= 500) return new RemoteError('server-error', `Aliyun answered HTTP ${status}`, status)
  if (/InvalidAccessKeyId|InvalidAccessKeySecret|Forbidden\.AccessKey|InvalidSecurityToken/i.test(code)) {
    return new RemoteError('aliyun-auth', 'the Aliyun AccessKey was rejected', status)
  }
  if (/SignatureDoesNotMatch/i.test(code)) {
    return new RemoteError('aliyun-signature', 'the Aliyun request signature did not match', status)
  }
  if (/NoPermission|NotAuthorized|Forbidden\.RAM/i.test(code)) {
    return new RemoteError('aliyun-permission', 'the RAM account may not read the BSS balance', status)
  }
  if (/Throttling/i.test(code)) {
    return new RemoteError('rate-limited', 'the Aliyun endpoint throttled the request', status)
  }
  if (status === 401 || status === 403) {
    return new RemoteError('aliyun-auth', 'the Aliyun request was rejected', status)
  }
  return new RemoteError('aliyun-api', message !== '' ? message : `Aliyun answered HTTP ${status}`, status)
}

/**
 * Turn one successful response into the card shape.
 * @param body - the parsed response body.
 * @returns the normalized balance.
 */
export function normalizeAliyunBalance(body) {
  if (body === null || typeof body !== 'object') {
    throw new RemoteError('bad-response', 'Aliyun reply is not an object')
  }
  const data = body.Data
  if (data === null || typeof data !== 'object') {
    throw new RemoteError('bad-response', 'Aliyun reply has no Data object')
  }
  const available = numberish(data.AvailableAmount)
  if (available === null) {
    throw new RemoteError('bad-response', 'Aliyun reply has no AvailableAmount')
  }
  const currency = typeof data.Currency === 'string' && data.Currency.trim() !== ''
    ? data.Currency.trim().toUpperCase()
    : 'CNY'
  return {
    available,
    cash: numberish(data.AvailableCashAmount),
    credit: numberish(data.CreditAmount),
    mybankCredit: numberish(data.MybankCreditAmount),
    quotaLimit: numberish(data.QuotaLimit),
    currency
  }
}

/**
 * Query the account balance once.
 * @param options - `{ accessKeyId, accessKeySecret, endpoint?, timeoutMs, fetchImpl?, now?, nonce? }`.
 * @returns `{ balance, ms, requestId }`.
 */
export async function fetchAliyunBalance(options) {
  const { accessKeyId, accessKeySecret } = options
  if (typeof accessKeyId !== 'string' || accessKeyId.trim() === '') {
    throw new RemoteError('no-key', 'no Aliyun AccessKey ID is configured')
  }
  if (typeof accessKeySecret !== 'string' || accessKeySecret.trim() === '') {
    throw new RemoteError('no-key', 'no Aliyun AccessKey Secret is configured')
  }
  const endpoint = normalizeEndpoint(options.endpoint)
  const at = options.now === undefined ? new Date() : new Date(options.now)
  const timestamp = at.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const nonce = options.nonce ?? randomUUID()
  const { query } = buildRpcQuery({
    accessKeyId: accessKeyId.trim(),
    secret: accessKeySecret.trim(),
    nonce,
    timestamp
  })
  const reply = await requestJson({
    url: `https://${endpoint}/?${query}`,
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  })
  const body = reply.body
  if (reply.status < 200 || reply.status >= 300 || body?.Success !== true) {
    throw aliyunError(reply.status, body)
  }
  return {
    balance: normalizeAliyunBalance(body),
    ms: reply.ms,
    requestId: typeof body.RequestId === 'string' ? body.RequestId : ''
  }
}
