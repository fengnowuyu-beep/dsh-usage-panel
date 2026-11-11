/**
 * Shared HTTP plumbing for every provider adapter.
 *
 * The contract is deliberately narrow: one request, a hard deadline, no retries,
 * and a classified failure that never carries the credential. Provider adapters
 * decide what a non-2xx body means; this module only guarantees that the call
 * returns or fails within the deadline.
 */
/** A classified remote failure. `code` is stable; `status` only for HTTP. */
export class RemoteError extends Error {
  /**
   * @param code - a machine code such as `timeout`, `network`, `unauthorized`.
   * @param message - a Host-side description; never contains a credential.
   * @param status - the HTTP status, when one applies.
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.status = status
  }
}

/**
 * Classify a transport-level failure (DNS, reset, TLS, abort).
 * @param error - whatever `fetch` threw.
 * @returns a {@link RemoteError}.
 */
export function transportError(error) {
  const cause = error !== null && typeof error === 'object' ? error.cause : undefined
  const code = typeof cause === 'object' && cause !== null ? String(cause.code ?? '') : ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new RemoteError('network', 'cannot resolve the API host (DNS)')
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return new RemoteError('network', 'the API host closed the connection')
  }
  if (code.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new RemoteError('network', 'TLS certificate verification failed')
  }
  const name = error !== null && typeof error === 'object' ? error.name : ''
  if (name === 'AbortError') return new RemoteError('timeout', 'request was aborted')
  return new RemoteError('network', 'request failed before a reply arrived')
}

/**
 * GET/POST a URL with a hard deadline and return the status plus parsed body.
 *
 * A non-2xx response is returned (not thrown): Aliyun reports its errors in the
 * body of a 400, so adapters need to read it. Transport failures and deadline
 * overruns are thrown as {@link RemoteError}.
 *
 * @param options - `{ url, method?, headers?, body?, timeoutMs, fetchImpl?, maxBytes? }`.
 * @returns `{ status, body, text, ms }`.
 */
export async function requestJson(options) {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    timeoutMs,
    fetchImpl = globalThis.fetch,
    maxBytes = 1_000_000
  } = options
  if (typeof fetchImpl !== 'function') {
    throw new RemoteError('network', 'this Node runtime has no fetch implementation')
  }
  const started = Date.now()
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RemoteError('timeout', `no reply within ${timeoutMs} ms`))
    }, timeoutMs)
  })
  const request = (async () => {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal
    })
    const text = await response.text()
    if (text.length > maxBytes) {
      throw new RemoteError('bad-response', 'the reply is unexpectedly large')
    }
    let parsed
    if (text.trim() === '') {
      parsed = null
    } else {
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new RemoteError('bad-response', 'the reply is not JSON')
      }
    }
    return { status: response.status, body: parsed, text }
  })().catch((error) => {
    if (error instanceof RemoteError) throw error
    throw transportError(error)
  })
  try {
    const reply = await Promise.race([request, deadline])
    return { ...reply, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
