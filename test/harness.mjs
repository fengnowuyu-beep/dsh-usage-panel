/**
 * A zero-dependency test harness: the suites must run on a machine with
 * nothing installed, so they bring their own runner instead of a framework.
 */

import { inspect } from 'node:util'

const cases = []

/** Register one case. */
export function test(name, fn) {
  cases.push({ name, fn })
}

/** Fail with a readable message. */
export function fail(message) {
  throw new Error(message)
}

/** Assert truthiness. */
export function ok(value, message = 'expected a truthy value') {
  if (!value) fail(`${message} (received ${inspect(value)})`)
}

/** Assert strict equality. */
export function equal(actual, expected, message = '') {
  if (actual !== expected) {
    fail(`${message === '' ? 'values differ' : message}: expected ${inspect(expected)}, received ${inspect(actual)}`)
  }
}

/** Assert deep equality over JSON-compatible values. */
export function deepEqual(actual, expected, message = '') {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) {
    fail(`${message === '' ? 'structures differ' : message}:\n  expected ${right}\n  received ${left}`)
  }
}

/** Assert that a call throws. */
export async function rejects(fn, message = 'expected a rejection') {
  try {
    await fn()
  } catch {
    return
  }
  fail(message)
}

/** Assert one value is within a tolerance of another. */
export function close(actual, expected, tolerance = 1e-9, message = '') {
  if (!(Math.abs(Number(actual) - Number(expected)) <= tolerance)) {
    fail(`${message === '' ? 'values differ' : message}: expected ${inspect(expected)} ±${tolerance}, received ${inspect(actual)}`)
  }
}

/** Run every registered case and exit non-zero on the first failure. */
export async function run(label) {
  let failed = 0
  for (const item of cases) {
    try {
      await item.fn()
      process.stdout.write(`  ok   ${item.name}\n`)
    } catch (error) {
      failed += 1
      const detail = process.env.DSH_TEST_STACK === '1' && error?.stack !== undefined
        ? error.stack
        : String(error?.message ?? error)
      process.stdout.write(`  FAIL ${item.name}\n       ${String(detail).split('\n').join('\n       ')}\n`)
    }
  }
  process.stdout.write(`${label}: ${cases.length - failed}/${cases.length} passed\n`)
  if (failed > 0) process.exitCode = 1
}
