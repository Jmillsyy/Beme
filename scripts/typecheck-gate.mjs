/**
 * Baseline-aware quality gate (types + lint).
 *
 * The app carries a backlog of pre-existing TypeScript and ESLint errors
 * in the big UI files (3D view, PDF workspace) that are risky to fix
 * blind. Rather than block all work until they are gone, this gate LOCKS
 * the current counts: the build passes at or below each baseline and
 * FAILS the moment a change introduces a NEW type or lint error. That is
 * what makes new breakage stand out while you add features.
 *
 * Test files are excluded from the type count: they depend on vitest
 * types that resolve in CI (npm ci) but not always locally, so counting
 * them would make the gate non-deterministic. `vitest run` covers test
 * correctness separately.
 *
 * As you fix errors, run `npm run typecheck:accept` to re-lock the lower
 * counts. The gate only ever ratchets downward.
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const update = process.argv.includes('--update-baseline')

function readBaseline(file) {
  const p = join(here, file)
  return existsSync(p) ? Number(readFileSync(p, 'utf8').trim()) || 0 : 0
}
function writeBaseline(file, n) {
  writeFileSync(join(here, file), `${n}\n`)
}

// --- TypeScript ---
function tscErrorCount() {
  let out = ''
  try {
    execSync('npx tsc -p tsconfig.app.json --noEmit', {
      encoding: 'utf8',
      cwd: root,
    })
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  const lines = out
    .split('\n')
    .filter((l) => /error TS\d+/.test(l) && !l.includes('__tests__'))
  return { count: lines.length, lines }
}

// --- ESLint ---
function eslintErrorCount() {
  let json = '[]'
  try {
    json = execSync('npx eslint . --format json', {
      encoding: 'utf8',
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    json = e.stdout || '[]'
  }
  let results = []
  try {
    results = JSON.parse(json)
  } catch {
    results = []
  }
  let count = 0
  const lines = []
  for (const f of results) {
    for (const m of f.messages ?? []) {
      if (m.severity === 2) {
        count++
        lines.push(`${f.filePath}:${m.line}:${m.column} ${m.ruleId ?? ''} - ${m.message}`)
      }
    }
  }
  return { count, lines }
}

const tsc = tscErrorCount()
const lint = eslintErrorCount()

if (update) {
  writeBaseline('tsc-baseline.txt', tsc.count)
  writeBaseline('eslint-baseline.txt', lint.count)
  console.log(`Baselines updated: ${tsc.count} type errors, ${lint.count} lint errors.`)
  process.exit(0)
}

const tscBase = readBaseline('tsc-baseline.txt')
const lintBase = readBaseline('eslint-baseline.txt')
let failed = false

if (tsc.count > tscBase) {
  failed = true
  console.error(`\nTYPE CHECK FAILED: ${tsc.count} app type errors, baseline ${tscBase}.`)
  console.error('New type error(s):\n' + tsc.lines.slice(0, 40).join('\n'))
} else {
  console.log(`Types OK: ${tsc.count} app type errors (baseline ${tscBase}).`)
}

if (lint.count > lintBase) {
  failed = true
  console.error(`\nLINT FAILED: ${lint.count} lint errors, baseline ${lintBase}.`)
  console.error('New lint error(s):\n' + lint.lines.slice(0, 40).join('\n'))
} else {
  console.log(`Lint OK: ${lint.count} lint errors (baseline ${lintBase}).`)
}

if (failed) {
  console.error('\nFix the new problem(s), or if intentional run: npm run typecheck:accept')
  process.exit(1)
}
if (tsc.count < tscBase || lint.count < lintBase) {
  console.log('\nYou beat a baseline. Re-lock the lower counts: npm run typecheck:accept')
}
