import { defineConfig } from 'tsdown'

// Two artifacts, one package:
//
// - `lib/index.js` — the host half (ESM, node22). tsdown bundles `src/index.ts`
//   into a single file and emits `lib/index.d.ts`. It is also the self-contained
//   `prepare` script for git installs: no project references, no type checking
//   (see guide §7.1 "build-script catch").
// - `lib/client.js` — the browser half. The host serves it to the page as a
//   lazy-CJS factory, so it must stay one self-contained IIFE with no external
//   imports besides the page module table (`require('react')` arrives as a
//   factory argument, never as a static import).
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: true,
    clean: true,
    sourcemap: false,
    outDir: 'lib',
    // With `platform: node` tsdown forces `.mjs`/`.cjs`; disable that so ESM
    // output follows the package `"type": "module"` and emits `lib/index.js` +
    // `lib/index.d.ts` — the paths this template's package.json declares.
    fixedExtension: false,
  },
  {
    entry: { client: 'src/client/index.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'chrome110',
    dts: false,
    clean: false,
    sourcemap: false,
    outDir: 'lib',
    outputOptions: { entryFileNames: 'client.js' },
  },
])
