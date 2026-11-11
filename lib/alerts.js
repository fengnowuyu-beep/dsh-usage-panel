/**
 * Balance-threshold evaluation.
 *
 * One rule for every card: the card names the number that matters (balance,
 * remaining percentage, custom value), and the settings name the threshold for
 * that card id. A threshold of 0/absent means "off". The comparison is strict:
 * a value exactly at the threshold is not an alert.
 */

/** @returns the metric value a card's alert should compare, or null. */
export function alertValue(card) {
  if (card === null || typeof card !== 'object') return null
  if (card.id === 'deepseek') {
    const value = Number(card.balance?.total)
    return Number.isFinite(value) ? value : null
  }
  if (card.id === 'minimax') {
    const value = Number(card.quota?.primary?.interval?.remainingPercent)
    return Number.isFinite(value) ? value : null
  }
  if (card.id === 'aliyun') {
    const value = Number(card.balance?.available)
    return Number.isFinite(value) ? value : null
  }
  const value = Number(card.balance?.value)
  return Number.isFinite(value) ? value : null
}

/**
 * Evaluate one card against the alert settings.
 * @param card - the card projection (must already carry its data).
 * @param alerts - `{ enabled, thresholds }`.
 * @returns `{ threshold, value }` or null.
 */
export function evaluateAlert(card, alerts) {
  if (alerts === null || typeof alerts !== 'object' || alerts.enabled !== true) return null
  const threshold = Number(alerts.thresholds?.[card?.id])
  if (!Number.isFinite(threshold) || threshold <= 0) return null
  const value = alertValue(card)
  if (value === null) return null
  return value < threshold ? { threshold, value } : null
}
