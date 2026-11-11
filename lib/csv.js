/**
 * CSV export for the panel.
 *
 * One document per scope (balances / ledger / sessions), UTF-8 BOM + CRLF so
 * Excel on Windows opens Chinese text correctly. Fields follow RFC 4180 and
 * never include credentials, header values or session message bodies.
 */

/** Excel-friendly UTF-8 BOM. */
export const BOM = '\uFEFF'

/** The scopes the export route accepts. */
export const EXPORT_SCOPES = Object.freeze(['balances', 'ledger', 'sessions'])

/**
 * Quote one field when RFC 4180 requires it.
 * @param value - string, number, boolean, null or undefined.
 * @returns the field text.
 */
export function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/**
 * Build a complete CSV document.
 * @param headers - column names.
 * @param rows - array of arrays.
 * @returns BOM + header + rows, CRLF line endings.
 */
export function csvDocument(headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(csvEscape).join(','))
  return `${BOM}${lines.join('\r\n')}\r\n`
}

/** @returns an ISO timestamp or ''. */
function isoTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  return new Date(value).toISOString()
}

/** @returns a balance number from any card shape, or ''. */
function balanceOf(balance) {
  if (balance === null || balance === undefined) return ''
  if (typeof balance.total === 'number') return balance.total
  if (typeof balance.available === 'number') return balance.available
  if (typeof balance.value === 'number') return balance.value
  return ''
}

/**
 * Export the official balances, one row per key (or per custom source).
 * @param snapshot - the Host snapshot.
 * @returns CSV text.
 */
export function exportBalances(snapshot) {
  const headers = ['service', 'key_label', 'key_mask', 'state', 'balance', 'currency', 'remaining_percent', 'alert', 'source', 'fetched_at']
  const rows = []
  for (const card of Array.isArray(snapshot?.cards) ? snapshot.cards : []) {
    if (card.kind === 'custom') {
      rows.push([
        card.name,
        '',
        '',
        card.state,
        balanceOf(card.balance),
        card.balance?.currency ?? '',
        '',
        card.alert ? 'true' : '',
        card.source,
        isoTime(card.fetchedAt)
      ])
      continue
    }
    const keys = Array.isArray(card.keys) ? card.keys : [{
      id: 'primary',
      label: '主 Key',
      masked: card.key?.masked ?? '',
      state: card.state,
      source: card.source,
      fetchedAt: card.fetchedAt,
      balance: card.balance ?? null,
      remainingPercent: card.quota?.primary?.interval?.remainingPercent ?? null
    }]
    for (const [index, key] of keys.entries()) {
      rows.push([
        card.name,
        key.label,
        key.masked,
        key.state,
        balanceOf(key.balance),
        key.balance?.currency ?? '',
        typeof key.remainingPercent === 'number' ? key.remainingPercent : '',
        index === 0 && card.alert ? 'true' : '',
        key.source,
        isoTime(key.fetchedAt)
      ])
    }
  }
  return csvDocument(headers, rows)
}

/**
 * Export the local ledger: daily totals plus model totals.
 * @param snapshot - the Host snapshot.
 * @returns CSV text.
 */
export function exportLedger(snapshot) {
  const headers = ['kind', 'date', 'provider', 'model', 'calls', 'tokens', 'cost']
  const ledger = snapshot?.ledger
  const rows = []
  if (ledger?.state !== 'unavailable') {
    for (const point of Array.isArray(ledger?.series) ? ledger.series : []) {
      rows.push(['daily', point.date ?? '', '', '', '', '', point.cost ?? ''])
    }
    for (const model of Array.isArray(ledger?.models) ? ledger.models : []) {
      rows.push([
        'model',
        '',
        model.providerName ?? model.provider ?? '',
        model.model ?? '',
        model.calls ?? '',
        model.tokens ?? '',
        model.cost ?? ''
      ])
    }
  }
  return csvDocument(headers, rows)
}

/**
 * Export the current month's session estimate.
 * @param sessions - `{ monthKey, sessions }` from `UsagePanel.sessions`.
 * @returns CSV text.
 */
export function exportSessions(sessions) {
  const headers = ['month', 'session_id', 'title', 'calls', 'tokens', 'cost', 'unpriced_calls', 'last_at']
  const month = sessions?.monthKey ?? ''
  const rows = (Array.isArray(sessions?.sessions) ? sessions.sessions : []).map((session) => [
    month,
    session.id,
    session.title ?? '',
    session.calls ?? '',
    session.tokens ?? '',
    session.cost ?? '',
    session.unpricedCalls ?? '',
    isoTime(session.lastAt)
  ])
  return csvDocument(headers, rows)
}

/**
 * Pick the exporter for a scope.
 * @param scope - `balances` | `ledger` | `sessions`.
 * @param data - snapshot or sessions payload.
 * @returns `{ filename, csv }` or null for an unknown scope.
 */
export function buildExport(scope, data, now = new Date()) {
  if (!EXPORT_SCOPES.includes(scope)) return null
  const body = scope === 'balances'
    ? exportBalances(data)
    : scope === 'ledger'
      ? exportLedger(data)
      : exportSessions(data)
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  return { filename: `usage-panel-${scope}-${date}.csv`, csv: body }
}
