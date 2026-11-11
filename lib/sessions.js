/**
 * Session-level usage, derived from DSH's own session logs.
 *
 * A log is an append-only file of concatenated zstd frames: one frame per
 * event, each frame holding one JSON line. The harness writes `session` (id,
 * cwd), `session/title`, and `assistant/message` events; the latter carry the
 * provider's `usage` and the model in `message.source.model`. That is enough to
 * price a session without reading any message text.
 *
 * Only aggregate numbers and the session title leave this module. Prompt and
 * message content are never returned, cached or logged.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { localMonthKey } from './ledger.js'
import { PRICING_META, totalTokens, usageCost } from './pricing.js'

/** Zstd frame magic, little-endian. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** How many session rows the payload carries. */
export const MAX_SESSION_ROWS = 20

/**
 * Decompress a file made of concatenated zstd frames.
 *
 * Node's zstd decoder stops after the first frame, so the buffer is split at
 * every frame magic and each segment is decoded on its own. A magic sequence
 * inside compressed bytes is theoretically possible but vanishingly unlikely;
 * a segment that fails to decode is counted, not thrown.
 *
 * @param buffer - the raw file bytes.
 * @returns `{ text, frames, skippedFrames }`.
 */
export function decompressFrames(buffer) {
  const starts = []
  let index = 0
  while ((index = buffer.indexOf(ZSTD_MAGIC, index)) >= 0) {
    starts.push(index)
    index += ZSTD_MAGIC.length
  }
  if (starts.length === 0) return { text: '', frames: 0, skippedFrames: 0 }
  starts.push(buffer.length)
  let text = ''
  let skippedFrames = 0
  for (let offset = 0; offset < starts.length - 1; offset += 1) {
    try {
      text += zstdDecompressSync(buffer.subarray(starts[offset], starts[offset + 1])).toString('utf8')
    } catch {
      skippedFrames += 1
    }
  }
  return { text, frames: starts.length - 1, skippedFrames }
}

/** The newest usage sample inside an `assistant/attempt` stream. */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/** The usage one assistant settlement reports. */
function usageOfEvent(event) {
  if (event?.data?.usage !== undefined) return event.data.usage
  return streamUsage(event?.data?.stream)
}

/** The model that produced one assistant message. */
function modelOfEvent(event) {
  const data = event?.data ?? {}
  const candidates = [
    data.message?.source?.model,
    data.source?.model,
    data.request?.model,
    data.header?.model,
    data.model
  ]
  return candidates.find((value) => typeof value === 'string' && value !== '') ?? ''
}

/** @returns a short id used when the session has no title. */
function shortId(id) {
  const value = typeof id === 'string' ? id : ''
  return value.startsWith('session-') ? value.slice(-8) : value.slice(-8)
}

/**
 * Split concatenated JSON values out of the decompressed stream.
 *
 * DSH writes one event per frame, and the frames normally include a newline —
 * but the decompressed text is not guaranteed to keep one between frames, so
 * this walks balanced objects instead of trusting line breaks.
 * @param text - decompressed log text.
 * @returns the parsed objects, in order.
 */
export function parseSessionEvents(text) {
  const events = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (character === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          events.push(JSON.parse(text.slice(start, index + 1)))
        } catch {
          // A malformed event is ignored; the rest of the log is still useful.
        }
        start = -1
      }
    }
  }
  return events
}

/**
 * Summarize one decompressed log.
 * @param buffer - raw log bytes.
 * @param options - `{ monthKey, fallbackId }`.
 * @returns one session aggregate, or null when the log has no usage this month.
 */
export function summarizeSessionBuffer(buffer, options) {
  const { monthKey, fallbackId = '' } = options
  const { text, frames, skippedFrames } = decompressFrames(buffer)
  if (text === '') return { skipped: true, frames, skippedFrames, session: null }

  let header = null
  let title = ''
  /** `turn:step` → last usage sample seen, mirroring the token-usage projection. */
  const usages = new Map()

  for (const event of parseSessionEvents(text)) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'session') {
      header = event
      continue
    }
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title
      continue
    }
    if (event.type !== 'assistant/message') continue
    const at = Number(event.time)
    if (!Number.isFinite(at) || localMonthKey(new Date(at)) !== monthKey) continue
    const usage = usageOfEvent(event)
    if (usage === null || typeof usage !== 'object') continue
    const turn = event.data?.turn ?? 0
    const step = event.data?.step ?? 0
    usages.set(`${turn}:${step}`, { usage, at, model: modelOfEvent(event) })
  }

  if (usages.size === 0) return { skipped: false, frames, skippedFrames, session: null }

  let cost = 0
  let tokens = 0
  let unpricedCalls = 0
  let lastAt = 0
  const unpricedModels = new Set()
  for (const sample of usages.values()) {
    const priced = usageCost(sample.model, sample.usage, sample.at)
    cost += priced.cost
    tokens += priced.tokens
    if (priced.unpricedTokens > 0) {
      unpricedCalls += 1
      if (sample.model !== '') unpricedModels.add(sample.model)
    }
    lastAt = Math.max(lastAt, sample.at)
  }

  const id = typeof header?.id === 'string' && header.id !== '' ? header.id : fallbackId
  return {
    skipped: false,
    frames,
    skippedFrames,
    session: {
      id,
      title: title !== '' ? title : shortId(id),
      calls: usages.size,
      tokens,
      cost,
      unpricedCalls,
      unpricedModels: [...unpricedModels],
      lastAt
    }
  }
}

/**
 * Walk the session store and summarize every log touched this month.
 *
 * A log whose mtime predates the month cannot contain a call this month, so it
 * is skipped without being read (the common case: hundreds of old sessions).
 *
 * @param options - `{ root, now?, readFileImpl?, maxRows? }`.
 * @returns the aggregate payload (never message content).
 */
export function scanSessions(options) {
  const root = options.root
  const now = options.now ?? new Date()
  const readFileImpl = options.readFileImpl ?? ((file) => readFileSync(file))
  const maxRows = options.maxRows ?? MAX_SESSION_ROWS
  const monthKey = localMonthKey(now)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const started = Date.now()

  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (entry.name !== 'session.v4.jsonl.zstd') continue
      let mtime = 0
      try {
        mtime = statSync(path).mtimeMs
      } catch {
        continue
      }
      if (mtime >= monthStart) files.push({ path, mtime })
    }
  }
  walk(root)
  files.sort((left, right) => right.mtime - left.mtime)

  const sessions = []
  let skipped = 0
  let scanned = 0
  for (const file of files) {
    scanned += 1
    let buffer
    try {
      buffer = readFileImpl(file.path)
    } catch {
      skipped += 1
      continue
    }
    const summary = summarizeSessionBuffer(buffer, {
      monthKey,
      fallbackId: file.path.slice(file.path.lastIndexOf('session-'))
    })
    if (summary.session === null) {
      if (summary.skipped) skipped += 1
      continue
    }
    sessions.push(summary.session)
  }

  sessions.sort((left, right) => right.cost - left.cost)
  return {
    monthKey,
    sessions: sessions.slice(0, maxRows),
    totalSessions: sessions.length,
    scanned,
    skipped,
    durationMs: Date.now() - started,
    pricing: PRICING_META
  }
}

/** @returns the total tokens helper re-exported for the tests. */
export { totalTokens }
