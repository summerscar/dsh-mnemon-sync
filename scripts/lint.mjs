#!/usr/bin/env node
/**
 * Development-time lint: syntax-check the repository's JavaScript sources.
 *
 * Deliberately MINIMAL. This is not the release gate — that is `pnpm check`,
 * run by the husky pre-commit hook. During development you only need to know
 * "did I break the syntax", not re-run the whole lifecycle / site / packaging
 * suite on every edit.
 *
 * It uses `node --check`, which parses without executing: no imports, no
 * network, no host services, no side effects. A file that parses is reported;
 * one that does not fails the run with its stderr.
 *
 * Scanned: every .js / .mjs / .cjs under plugins/, scripts/ and site/,
 * skipping node_modules and any build output directories.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const targets = ['plugins', 'scripts', 'site']
const extensions = ['.js', '.mjs', '.cjs']
const ignoredDirs = new Set(['node_modules', '.npm-cache', '_site', 'dist', 'lib'])

/** Walk one directory, yielding file paths that look like source. */
function* walk(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue
      yield* walk(path)
    } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
      yield path
    }
  }
}

const files = []
for (const target of targets) {
  const base = join(root, target)
  try { if (!statSync(base).isDirectory()) continue } catch { continue }
  for (const file of walk(base)) files.push(file)
}

const failures = []
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failures.push({ file: relative(root, file), message: (result.stderr || result.stdout || 'unknown parse error').trim() })
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`\n✖ ${failure.file}\n${failure.message}\n`)
  }
  process.stderr.write(`\n${failures.length} file(s) failed the syntax check.\n`)
  process.exit(1)
}

process.stdout.write(`✓ syntax OK — ${files.length} JavaScript file(s) checked\n`)
