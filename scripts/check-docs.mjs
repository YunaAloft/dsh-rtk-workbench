#!/usr/bin/env node
// Repository-owned documentation checks for a DSH plugin.
//
// The community scaffold used to enforce a five-language README and matching
// headings across all of them. This template replaces that with the policy the
// repository actually owns:
// - a README.md exists, and every other README*.md variant shares its `## `
//   headings (language count is the repository's choice);
// - every relative link in README*.md and docs/**/*.md resolves to a real file.
//
// Discovery is path-based, so there is nothing to edit for a standard layout:
// drop the script into scripts/ and run it after the docs exist.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.argv[2] ?? process.cwd()
const passed = []
const failed = []
const check = (condition, label) => {
  ;(condition ? passed : failed).push(label)
}

/** README variants at the root plus every Markdown file under docs/. */
function collectDocs() {
  const docs = []
  for (const name of readdirSync(root)) {
    if (/^README.*\.md$/i.test(name)) docs.push(join(root, name))
  }
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (name.endsWith('.md')) docs.push(path)
    }
  }
  if (existsSync(join(root, 'docs'))) walk(join(root, 'docs'))
  return [...new Set(docs)]
}

/** `## ` headings of one markdown file, in order. */
function headingsOf(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim())
}

const readme = join(root, 'README.md')
check(existsSync(readme), 'README.md exists')
const docs = collectDocs()
const readmeVariants = docs.filter((file) => /[\\/]README.*\.md$/i.test(file))

if (existsSync(readme)) {
  const base = headingsOf(readme)
  for (const file of readmeVariants) {
    if (file === readme) continue
    check(
      JSON.stringify(headingsOf(file)) === JSON.stringify(base),
      `${relative(root, file)} headings match README.md`,
    )
  }
}

const LINK = /!?\[[^\]]*\]\(([^)]+)\)/g

for (const file of docs) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
  const base = dirname(file)
  const label = relative(root, file)
  for (const match of text.matchAll(LINK)) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    if (/^(?:https?:|mailto:|data:|#)/i.test(target)) continue
    const path = target.split('#')[0].split('?')[0]
    if (path === '') continue
    check(existsSync(resolve(base, path)), `${label}: link target exists (${path})`)
  }
}

for (const label of passed) console.log(`✓ ${label}`)
for (const label of failed) console.error(`✗ ${label}`)
if (failed.length > 0) {
  console.error(`docs-check: ${failed.length} failure(s)`)
  process.exit(1)
}
console.log(`docs-check: ok — ${passed.length} checks`)
