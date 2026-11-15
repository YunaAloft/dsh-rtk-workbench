#!/usr/bin/env node
// Repository-owned guard for the plugin detail preview and its wiring.
//
// The shipped pair is 1280×600 PNG on purpose: the official preview spec asks
// for a 640×300 SVG with text converted to paths, but Chromium rasterizes such
// paths at 1x without hinting, so 1px stems split into pale columns and look
// broken. A 1280×600 PNG is downscaled to 640 CSS px by the detail page, which
// behaves like supersampling and stays crisp without depending on fonts.
//
// This guard covers the whole hand-off, not just the bytes:
// - both PNGs are real 1280×600 images, differ, and the pair is at most 1 MiB;
// - each DETAIL document is exactly one image line pointing at its variant;
// - locale/{en,zh}.json declare those DETAIL documents via meta.detail;
// - package.json#files ships the four files and does not pull in docs/readme
//   (the 1.5 MB banner is repository material, not package content).
//
// Usage: node scripts/check-preview.mjs [package-root]

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const WIDTH = 1280
const HEIGHT = 600
const MAX_PAIR_BYTES = 1024 * 1024

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const docs = join(root, 'docs')
const images = { en: join(docs, 'preview.png'), zh: join(docs, 'preview.zh.png') }
const details = { en: join(docs, 'DETAIL.md'), zh: join(docs, 'DETAIL.zh.md') }
const detailImages = { en: 'preview.png', zh: 'preview.zh.png' }
const detailPaths = { en: 'docs/DETAIL.md', zh: 'docs/DETAIL.zh.md' }
const problems = []
const check = (condition, label) => {
  if (!condition) problems.push(label)
}

/** Read a PNG's pixel size from its IHDR chunk, or undefined when it is not a PNG. */
function pngSize(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

for (const [language, file] of Object.entries(images)) {
  if (!existsSync(file)) {
    problems.push(`${language}: ${file} is missing`)
    continue
  }
  const bytes = readFileSync(file)
  const size = pngSize(bytes)
  check(size !== undefined, `${language}: ${file} is a PNG`)
  if (size !== undefined) {
    check(
      size.width === WIDTH && size.height === HEIGHT,
      `${language}: ${file} is ${WIDTH}×${HEIGHT} (2× the 640×300 layout); got ${size.width}×${size.height}`,
    )
  }
  check(statSync(file).size <= MAX_PAIR_BYTES, `${language}: ${file} is at most 1 MiB by itself`)
}

if (Object.values(images).every(file => existsSync(file))) {
  const total = Object.values(images).reduce((sum, file) => sum + statSync(file).size, 0)
  check(total <= MAX_PAIR_BYTES, `pair is at most 1 MiB (${total} bytes)`)
  check(readFileSync(images.en).equals(readFileSync(images.zh)) === false, 'Chinese variant differs from the English one')
}

for (const [language, file] of Object.entries(details)) {
  if (!existsSync(file)) {
    problems.push(`${language}: ${file} is missing`)
    continue
  }
  const text = readFileSync(file, 'utf8').trim()
  const image = detailImages[language].replace(/\./gu, '\\.')
  check(!text.includes('\n'), `${language}: ${file} is exactly one line`)
  check(new RegExp(`^!\\[[^\\]]*\\]\\(${image}\\)$`, 'u').test(text), `${language}: ${file} references ${detailImages[language]}`)
}

for (const language of ['en', 'zh']) {
  const file = join(root, 'locale', `${language}.json`)
  if (!existsSync(file)) {
    problems.push(`${language}: ${file} is missing`)
    continue
  }
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')).meta ?? {}
    check(meta.detail === detailPaths[language], `${language}: ${file} meta.detail is ${detailPaths[language]}`)
  } catch (error) {
    problems.push(`${language}: ${file} parses as JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

const manifestFile = join(root, 'package.json')
if (!existsSync(manifestFile)) {
  problems.push('package.json is missing')
} else {
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const files = Array.isArray(manifest.files) ? manifest.files : []
    for (const path of [...Object.values(detailPaths), 'docs/preview.png', 'docs/preview.zh.png']) {
      check(files.includes(path), `package.json#files ships ${path}`)
    }
    check(
      !files.some(entry => entry === 'docs' || entry.startsWith('docs/readme')),
      'package.json#files does not pull in docs/readme (the 1.5 MB banner)',
    )
  } catch (error) {
    problems.push(`package.json parses as JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

if (problems.length > 0) {
  console.error(`check-preview: ${problems.length} problem(s) in ${root}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-preview: ok (${root})`)
