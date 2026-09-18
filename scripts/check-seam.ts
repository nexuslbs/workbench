#!/usr/bin/env node
/**
 * Seam enforcement for the credentials capability (and any future capability
 * that uses the same three-role shape):
 *
 *        Provider  ->  Definition  <-  Consumer
 *
 * Roles by file:
 *   definition = src/credentials/definition.ts
 *   provider   = a module under src/credentials/providers/ (or a plugin from
 *                another repository - this check cannot see those, which is why
 *                the contract is also documented in docs/PLUGIN-CONTRACT.md)
 *   consumer   = a module that uses the capability (src/config.ts, src/cli.ts)
 *   plugin     = plugins/**  (a plugin is always a consumer of core services)
 *   root       = src/kernel.ts, src/index.ts  (the COMPOSITION ROOT: wiring the
 *                providers in is exactly its job, so it may import both sides)
 *
 * Rules:
 *   1. a consumer (and a plugin) imports the DEFINITION only; importing a
 *      concrete provider module is a violation,
 *   2. a provider must not import a consumer - the dependency arrow points at
 *      the definition, never the other way round,
 *   3. the definition imports nothing from this package at all.
 *
 * Usage: node scripts/check-seam.ts [root]
 * Exit code 1 when a violation is found, 0 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DEFINITION = 'src/credentials/definition.ts'
const PROVIDERS_DIR = 'src/credentials/providers/'
const CONSUMERS = ['src/config.ts', 'src/cli.ts']
const COMPOSITION_ROOT = ['src/kernel.ts', 'src/index.ts']
const PLUGINS_DIR = 'plugins/'

type Layer = 'definition' | 'provider' | 'consumer' | 'plugin' | 'root' | 'other'

/** Relative paths are matched on '/'; unknown files are `other` (not role bound). */
function layerOf(relative: string): Layer {
  if (relative === DEFINITION) return 'definition'
  if (relative.startsWith(PROVIDERS_DIR)) return 'provider'
  if (CONSUMERS.includes(relative)) return 'consumer'
  if (COMPOSITION_ROOT.includes(relative)) return 'root'
  if (relative.startsWith(PLUGINS_DIR)) return 'plugin'
  return 'other'
}

const RULES: { target: Layer; allowed: Layer[]; because: string }[] = [
  {
    target: 'provider',
    allowed: ['provider', 'root'],
    because:
      'a consumer/plugin imports the DEFINITION and calls `ctx.credentials`; only the composition root may name a concrete provider',
  },
  {
    target: 'consumer',
    allowed: ['consumer', 'root', 'other'],
    because: 'a provider implements the definition and must never depend on a consumer (Provider -> Definition <- Consumer)',
  },
  {
    target: 'definition',
    allowed: ['provider', 'consumer', 'plugin', 'root', 'other', 'definition'],
    because: 'the definition is the contract every role talks to',
  },
]

const IMPORT_PATTERN = /(?:^|[^\w.$])(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // A fixture (or a fresh checkout) may not have the directory at all.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out
    throw error
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function toRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

/** Resolves a relative import specifier to a repo relative .ts path. */
function resolveSpecifier(root: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return toRelative(root, candidate)
  }
  return toRelative(root, base)
}

function specifiersOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const specs: string[] = []
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const spec = match[1] ?? match[2]
    if (spec) specs.push(spec)
  }
  return specs
}

interface Violation {
  file: string
  layer: Layer
  target: string
  targetLayer: Layer
  because: string
}

export function checkSeam(root: string): { scanned: number; violations: Violation[] } {
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'plugins'))]
  const violations: Violation[] = []
  for (const file of files) {
    const relative = toRelative(root, file)
    const layer = layerOf(relative)
    for (const specifier of specifiersOf(file)) {
      const target = resolveSpecifier(root, file, specifier)
      if (target === undefined) continue
      const targetLayer = layerOf(target)
      const rule = RULES.find((candidate) => candidate.target === targetLayer)
      if (!rule) continue
      if (rule.allowed.includes(layer)) continue
      violations.push({ file: relative, layer, target, targetLayer, because: rule.because })
    }
  }
  return { scanned: files.length, violations }
}

function main(): void {
  const root = path.resolve(process.argv[2] ?? DEFAULT_ROOT)
  const { scanned, violations } = checkSeam(root)
  if (violations.length === 0) {
    process.stdout.write(`seam check: OK (${scanned} module(s) scanned, direction Provider -> Definition <- Consumer holds)\n`)
    return
  }
  process.stderr.write(`seam check: FAILED (${violations.length} violation(s))\n`)
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file} (${violation.layer}) imports ${violation.target} (${violation.targetLayer})\n`)
    process.stderr.write(`    ${violation.because}\n`)
  }
  process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
