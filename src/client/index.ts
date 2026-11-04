/**
 * Browser half of dsh-rtk-workbench: a composer-dock pill and its overlay.
 *
 * The host serves this file as a lazy-CJS factory
 * (`window.__ModuleLoader__.load({ id, factory })`); `factory(require)` receives
 * the browser module table and returns a Cordis plugin with `apply(ctx)`. React
 * comes from that table — the plugin must not install or import its own copy.
 *
 * Copy lives in a locale dictionary (see `dict.ts`); data comes from the host's
 * read-only `GET /api/rtk-workbench/status` route, polled only while the page is
 * visible. Nothing here writes configuration.
 *
 * @module dsh-rtk-workbench/client
 */

import { dictionaries, NS } from './dict'
import {
  panelSections,
  pillText,
  pillVisible,
  readStatus,
  toneOf,
  type PanelRow,
  type StatusView,
  type Translate,
} from './model'

const ID = 'dsh-rtk-workbench'
const POLL_INTERVAL_MS = 5000

interface ReactLike {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown
  useState: <T>(initial: T) => [T, (next: T) => void]
  useEffect: (effect: () => undefined | (() => void), deps?: readonly unknown[]) => void
}

interface SlotsLike {
  inject(name: string, factory: () => () => void): void
  register(options: Record<string, unknown>, component: (props: unknown) => unknown): () => void
}

interface LocaleLike {
  register(namespace: string, tables: Record<string, Record<string, string>>): () => void
  bind(namespace: string): Translate
}

interface ClientContext {
  readonly slots: SlotsLike
  readonly locale?: LocaleLike
  effect(register: () => () => void): void
}

/** Everything the two components read. */
interface Snapshot {
  view: StatusView | undefined
  error: string | undefined
  open: boolean
  doctor: string | undefined
  busy: boolean
  copied: boolean
}

const store: Snapshot = { view: undefined, error: undefined, open: false, doctor: undefined, busy: false, copied: false }
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A crashing listener must not take the others (or the page) down.
    }
  }
}

function patch(next: Partial<Snapshot>): void {
  Object.assign(store, next)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Fill `{name}` placeholders without a dependency. */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match))
}

/** Translator used before the host locale service is available. */
function builtinTranslate(): Translate {
  const language = typeof document === 'undefined' ? 'en' : document.documentElement.lang
  const table = language.toLowerCase().startsWith('zh') ? dictionaries.zh : dictionaries.en
  return (key, params) => interpolate((table as Record<string, string>)[key] ?? key, params)
}

let translate: Translate = builtinTranslate()

/** Route prefix, resolved against the page base so a sub-path mount still works. */
function statusUrl(): string {
  try {
    return new URL('api/rtk-workbench/status', document.baseURI).pathname
  } catch {
    return '/api/rtk-workbench/status'
  }
}

function doctorUrl(): string {
  try {
    return new URL('api/rtk-workbench/doctor', document.baseURI).pathname
  } catch {
    return '/api/rtk-workbench/doctor'
  }
}

let inflight = false

/** Fetch one status document; the last good view survives a failed poll. */
async function refresh(): Promise<void> {
  if (inflight) return
  inflight = true
  try {
    const response = await fetch(statusUrl(), { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const view = readStatus(await response.json())
    if (view === undefined) throw new Error('unexpected status payload')
    patch({ view, error: undefined })
  } catch (error) {
    patch({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    inflight = false
  }
}

/** Poll only while the page is visible. */
function startPolling(): () => void {
  if (typeof document === 'undefined') return () => undefined
  void refresh()
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, POLL_INTERVAL_MS)
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') void refresh()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

/** Run the host-side self-check on demand. */
async function runDoctor(): Promise<void> {
  patch({ busy: true })
  try {
    const response = await fetch(doctorUrl(), { method: 'POST', headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const body = (await response.json()) as { text?: unknown }
    patch({ doctor: typeof body.text === 'string' ? body.text : translate('panel.doctorFailed') })
  } catch (error) {
    patch({ doctor: error instanceof Error ? error.message : translate('panel.doctorFailed') })
  } finally {
    patch({ busy: false })
  }
}

/** Copy the last status document for a bug report. */
async function copyDiagnostics(): Promise<void> {
  try {
    const text = JSON.stringify(store.view ?? { error: store.error ?? 'no data' }, null, 2)
    await navigator.clipboard.writeText(text)
    patch({ copied: true })
    setTimeout(() => {
      patch({ copied: false })
    }, 1500)
  } catch {
    patch({ copied: false })
  }
}

const CSS = `
.rtkw-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;cursor:pointer;max-width:340px}
.rtkw-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rtkw-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.rtkw-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.rtkw-warn .rtkw-dot{background:var(--dsw-alias-state-warn-primary)}
.rtkw-off .rtkw-dot{background:var(--dsw-alias-state-idle-primary)}
.rtkw-primary{white-space:nowrap;font-variant-numeric:tabular-nums}
.rtkw-secondary{color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rtkw-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;background:var(--dsw-alias-bg-mask-1);padding:24px}
.rtkw-panel{width:min(640px,100%);max-height:min(70vh,720px);overflow:auto;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:16px;font-size:13px}
.rtkw-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.rtkw-close{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;padding:4px 8px;border-radius:6px}
.rtkw-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rtkw-section{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.rtkw-section h4{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 6px;text-transform:none}
.rtkw-row{display:flex;justify-content:space-between;gap:16px;padding:2px 0}
.rtkw-row dt{color:var(--dsw-alias-label-tertiary);min-width:88px}
.rtkw-row dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.rtkw-row dd.rtkw-warn{color:var(--dsw-alias-state-warn-primary)}
.rtkw-row dd.rtkw-ok{color:var(--dsw-alias-state-success-primary)}
.rtkw-note{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.rtkw-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
.rtkw-action{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.rtkw-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rtkw-action:disabled{opacity:.6;cursor:default}
.rtkw-fine{flex:1 1 100%;margin:6px 0 0;color:var(--dsw-alias-label-caption);font-size:11px}
.rtkw-doctor{margin:8px 0 0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto}
`

let stylesInjected = false

/** Inject the stylesheet once; component-local styles would flicker on remount. */
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  const id = 'rtk-workbench-styles'
  if (document.getElementById(id) !== null) {
    stylesInjected = true
    return
  }
  const style = document.createElement('style')
  style.id = id
  style.textContent = CSS
  document.head.appendChild(style)
  stylesInjected = true
}

function pickTranslate(props: unknown): Translate {
  const candidate = (props as { t?: unknown } | null)?.t
  return typeof candidate === 'function' ? (candidate as Translate) : translate
}

function element(children: readonly unknown[]): unknown[] {
  return children.filter((child) => child !== null && child !== undefined && child !== false)
}

/**
 * Build the client plugin.
 *
 * Not exported: the bundle is consumed for its registration side effect only,
 * and an IIFE entry with no exports needs no `output.name` global.
 *
 * @param require - the page module table; `react` is the only request.
 */
function createClientPlugin(require: (id: string) => unknown): {
  name: string
  inject: readonly string[]
  apply(ctx: ClientContext): void
} {
  const React = require('react') as ReactLike
  const h = React.createElement

  function useSnapshot(): Snapshot {
    const [snapshot, setSnapshot] = React.useState<Snapshot>({ ...store })
    React.useEffect(() => subscribe(() => setSnapshot({ ...store })), [])
    return snapshot
  }

  function Pill(props: unknown): unknown {
    const snapshot = useSnapshot()
    const t = pickTranslate(props)
    if (!pillVisible(snapshot.view)) return null
    const view = snapshot.view
    const tone = toneOf(view, snapshot.error)
    const text = pillText(view, snapshot.error, t)
    return h(
      'button',
      {
        type: 'button',
        className: `rtkw-pill rtkw-${tone}`,
        title: text.secondary,
        'aria-haspopup': 'dialog',
        'aria-expanded': snapshot.open ? 'true' : 'false',
        onClick: () => patch({ open: true }),
      },
      ...element([
        h('span', { className: 'rtkw-dot', 'aria-hidden': true }),
        h('span', { className: 'rtkw-primary' }, text.primary),
        text.secondary === '' ? null : h('span', { className: 'rtkw-secondary' }, text.secondary),
      ]),
    )
  }

  function row(t: Translate, entry: PanelRow, index: number): unknown {
    return h(
      'div',
      { className: 'rtkw-row', key: `${entry.label}-${String(index)}` },
      h('dt', null, entry.label),
      h('dd', entry.tone === undefined ? null : { className: `rtkw-${entry.tone}` }, entry.value),
    )
  }

  function Panel(props: unknown): unknown {
    const snapshot = useSnapshot()
    const t = pickTranslate(props)
    React.useEffect(() => {
      if (!snapshot.open) return
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') patch({ open: false })
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [snapshot.open])
    if (!snapshot.open) return null
    const sections = panelSections(snapshot.view, snapshot.error, t)
    return h(
      'div',
      {
        className: 'rtkw-overlay',
        role: 'presentation',
        onClick: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) patch({ open: false })
        },
      },
      h(
        'div',
        { className: 'rtkw-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('panel.title') },
        ...element([
          h(
            'header',
            { className: 'rtkw-head' },
            h('strong', null, t('panel.title')),
            h(
              'button',
              { type: 'button', className: 'rtkw-close', 'aria-label': t('panel.close'), onClick: () => patch({ open: false }) },
              '✕',
            ),
          ),
          ...sections.map((section) =>
            h(
              'section',
              { className: 'rtkw-section', key: section.title },
              ...element([
                h('h4', null, section.title),
                section.rows.length === 0 ? null : h('dl', null, ...section.rows.map((entry, index) => row(t, entry, index))),
                section.note === undefined ? null : h('p', { className: 'rtkw-note' }, section.note),
              ]),
            ),
          ),
          snapshot.doctor === undefined ? null : h('pre', { className: 'rtkw-doctor' }, snapshot.doctor),
          h(
            'footer',
            { className: 'rtkw-foot' },
            h(
              'button',
              {
                type: 'button',
                className: 'rtkw-action',
                disabled: snapshot.busy,
                onClick: () => {
                  void runDoctor()
                },
              },
              t('panel.doctor'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'rtkw-action',
                onClick: () => {
                  void copyDiagnostics()
                },
              },
              snapshot.copied ? t('panel.copied') : t('panel.copy'),
            ),
            h('p', { className: 'rtkw-fine' }, t('panel.footnote')),
          ),
        ]),
      ),
    )
  }

  return {
    name: ID,
    inject: ['slots', 'locale'],
    apply(ctx: ClientContext): void {
      const locale = ctx.locale
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, dictionaries))
      }
      if (locale !== undefined && typeof locale.bind === 'function') {
        translate = locale.bind(NS)
      }
      ctx.effect(() => {
        injectStyles()
        return startPolling()
      })
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: ID, order: 2, locale: NS }, Pill),
      )
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: `${ID}.details`, locale: NS }, Panel),
      )
    },
  }
}

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
    }
  }
}

// The host scans the built bundle for this registration; a missing loader (unit
// tests, SSR) simply leaves the module inert.
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({ id: ID, factory: createClientPlugin })
}
