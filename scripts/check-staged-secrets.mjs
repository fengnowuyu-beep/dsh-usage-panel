/**
 * Pre-commit secret scan for this repository.
 *
 * Run it after `git add`, before `git commit`:
 *
 *   node scripts/check-staged-secrets.mjs
 *
 * It reads the staged diff (not the working tree), so an untracked or ignored
 * local credential can never make a commit look dirty when it is not. Exit code
 * 1 means "stop and look", never "this is definitely a live key": the goal is to
 * catch a real key pasted into source, docs, fixtures or a screenshot's alt text.
 */
import { execFileSync } from 'node:child_process'

/** Patterns that should never appear in a staged change. */
const RULES = [
  {
    name: 'DeepSeek-style API key',
    // Real keys are typically 30+ chars after `sk-`; keep the threshold above
    // the short fixtures the tests use.
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g
  },
  {
    name: 'Aliyun AccessKey id',
    pattern: /\bLTAI[A-Za-z0-9]{12,}\b/g
  },
  {
    name: 'Aliyun AccessKey secret assignment',
    pattern: /AccessKeySecret\s*[:=]\s*['"][^'"\s]{12,}['"]/gi
  },
  {
    name: 'Non-placeholder apiKey assignment',
    // Real provider keys are long; the threshold stays above the short fake
    // values the tests use (`sk-abcdefgh12345678` is 19 characters).
    pattern: /(?:apiKey|accessKeySecret|secretKey)\s*[:=]\s*['"](?!sk-REPLACE|REPLACE|test-|fixture|example|your-)[^'"\s]{24,}['"]/gi
  },
  {
    name: 'Private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  }
]

let staged
try {
  staged = execFileSync('git', ['diff', '--cached', '--unified=0'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} catch (error) {
  console.error(`cannot read the staged diff: ${error.message}`)
  process.exit(2)
}

const findings = []
for (const rule of RULES) {
  rule.pattern.lastIndex = 0
  for (const match of staged.matchAll(rule.pattern)) {
    const start = Math.max(0, match.index - 80)
    const snippet = staged.slice(start, match.index + match[0].length + 40)
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
    findings.push(`${rule.name}: ${snippet}`)
  }
}

if (findings.length > 0) {
  console.error('staged changes contain something that looks like a credential:')
  for (const finding of findings) console.error(`  ${finding}`)
  console.error('')
  console.error('Unstage it with `git restore --staged <file>`, remove the value, and retry.')
  process.exit(1)
}

console.log('staged secret scan: no credential-like value found')
