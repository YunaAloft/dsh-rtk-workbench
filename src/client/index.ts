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
import { injectStyles } from './styles'
import {
  doctorCollapsedLabel,
  doctorStamp,
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
  register(
    options: Record<string, unknown> & { inject?: (sessionId: string | undefined) => Record<string, unknown> },
    component: (props: unknown) => unknown,
  ): () => void
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
  /** Completion time of the last self-check, epoch ms. */
  doctorAt: number | undefined
  /** Whether the self-check request itself failed (not whether a line says fail). */
  doctorFailed: boolean
  /** Whether the self-check body is expanded inside the overlay. */
  doctorOpen: boolean
  doctorCopied: boolean
  doctorCopyFailed: boolean
  /** Whether the "how to read this" drawer is open above the overlay. */
  helpOpen: boolean
  busy: boolean
  copied: boolean
  copyFailed: boolean
  /** Session the pill currently renders for (from the slot's `inject`). */
  currentSessionKey: string | undefined
}

const store: Snapshot = {
  view: undefined,
  error: undefined,
  open: false,
  doctor: undefined,
  doctorAt: undefined,
  doctorFailed: false,
  doctorOpen: false,
  doctorCopied: false,
  doctorCopyFailed: false,
  helpOpen: false,
  busy: false,
  copied: false,
  copyFailed: false,
  currentSessionKey: undefined,
}
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
function statusUrl(sessionKey: string | undefined): string {
  const suffix = sessionKey === undefined || sessionKey === '' ? '' : `?session=${encodeURIComponent(sessionKey)}`
  try {
    return new URL('api/rtk-workbench/status', document.baseURI).pathname + suffix
  } catch {
    return '/api/rtk-workbench/status' + suffix
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
    const response = await fetch(statusUrl(store.currentSessionKey), { headers: { accept: 'application/json' }, cache: 'no-store' })
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

/**
 * Point the pill at another session. The slot machinery re-runs `inject` on a
 * session switch; without this the module-level store would keep showing the
 * previous session's numbers until the next poll after a tool call.
 */
function setCurrentSessionKey(key: string | undefined): void {
  if (store.currentSessionKey === key) return
  patch({ currentSessionKey: key, view: undefined })
  void refresh()
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
    const text = typeof body.text === 'string' ? body.text : translate('panel.doctorFailed')
    patch({
      doctor: text,
      doctorAt: Date.now(),
      doctorFailed: typeof body.text !== 'string',
      // The user explicitly asked for this run: show the result immediately.
      doctorOpen: true,
      doctorCopied: false,
      doctorCopyFailed: false,
    })
  } catch (error) {
    patch({
      doctor: error instanceof Error ? error.message : translate('panel.doctorFailed'),
      doctorAt: Date.now(),
      doctorFailed: true,
      // A failure needs to be visible too; silence here looks like a no-op.
      doctorOpen: true,
      doctorCopied: false,
      doctorCopyFailed: false,
    })
  } finally {
    patch({ busy: false })
  }
}

/** Drop the last self-check result without touching the status snapshot. */
function clearDoctor(): void {
  patch({
    doctor: undefined,
    doctorAt: undefined,
    doctorFailed: false,
    doctorOpen: false,
    doctorCopied: false,
    doctorCopyFailed: false,
  })
}

/** Copy the collapsed self-check with its timestamp as the first line. */
async function copyDoctor(): Promise<void> {
  const { doctor, doctorAt } = store
  if (doctor === undefined || doctorAt === undefined) return
  const text = `${doctorStamp(translate, doctorAt)}\n${doctor}`
  try {
    await navigator.clipboard.writeText(text)
    patch({ doctorCopied: true, doctorCopyFailed: false })
    setTimeout(() => {
      patch({ doctorCopied: false })
    }, 1500)
  } catch {
    patch({ doctorCopied: false, doctorCopyFailed: true })
    setTimeout(() => {
      patch({ doctorCopyFailed: false })
    }, 1500)
  }
}

/** Copy the last status document for a bug report. */
async function copyStatus(): Promise<void> {
  try {
    const text = JSON.stringify(store.view ?? { error: store.error ?? 'no data' }, null, 2)
    await navigator.clipboard.writeText(text)
    patch({ copied: true, copyFailed: false })
    setTimeout(() => {
      patch({ copied: false })
    }, 1500)
  } catch {
    patch({ copied: false, copyFailed: true })
    setTimeout(() => {
      patch({ copyFailed: false })
    }, 1500)
  }
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
    const view = snapshot.view
    if (!pillVisible(view, snapshot.error)) return null
    const tone = toneOf(view, snapshot.error)
    const text = pillText(view, snapshot.error, t, snapshot.currentSessionKey)
    const split = text.split
    return h(
      'button',
      {
        type: 'button',
        className: `rtkw-pill rtkw-${tone}`,
        title: text.secondary,
        'aria-haspopup': 'dialog',
        'aria-expanded': snapshot.open ? 'true' : 'false',
        ...(split === undefined ? {} : { 'data-split': 'true' }),
        onClick: () => patch({ open: true, doctorOpen: false, helpOpen: false }),
      },
      ...element([
        h(
          'svg',
          { className: 'rtkw-icon', viewBox: '0 0 16 16', 'aria-hidden': true },
          h('rect', { x: 2, y: 3, width: 12, height: 2, rx: 1 }),
          h('rect', { x: 2, y: 7, width: 8, height: 2, rx: 1 }),
          h('rect', { x: 2, y: 11, width: 12, height: 2, rx: 1 }),
        ),
        h('span', { className: 'rtkw-dot', 'aria-hidden': true }),
        split === undefined
          ? h('span', { className: 'rtkw-primary' }, text.primary)
          : h(
              'span',
              { className: 'rtkw-primary' },
              h('span', { className: 'rtkw-saved' }, split.saved),
              h('span', { className: 'rtkw-sep' }, split.separator),
              h('span', { className: 'rtkw-pct' }, split.reduction),
            ),
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
    const closePanel = (): void => patch({ open: false, doctorOpen: false, helpOpen: false })
    React.useEffect(() => {
      if (!snapshot.open) return
      const onKey = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        if (snapshot.helpOpen) {
          patch({ helpOpen: false })
        } else {
          closePanel()
        }
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [snapshot.open, snapshot.helpOpen])
    if (!snapshot.open) return null

    const sections = panelSections(snapshot.view, snapshot.error, t, snapshot.currentSessionKey)
    const scrollToDiagnostics = (): void => {
      document.getElementById('rtkw-diagnostics')?.scrollIntoView({ block: 'start' })
    }
    const sectionNode = (section: (typeof sections)[number], index: number): unknown =>
      h(
        'section',
        { className: 'rtkw-section', key: section.title },
        ...element([
          h('h4', null, section.title),
          section.rows.length === 0 ? null : h('dl', null, ...section.rows.map((entry, rowIndex) => row(t, entry, rowIndex))),
          section.note === undefined ? null : h('p', { className: 'rtkw-note' }, section.note),
          index === 0
            ? h(
                'button',
                { type: 'button', className: 'rtkw-shortcut', onClick: scrollToDiagnostics },
                t('panel.diagnosticsShortcut'),
              )
            : null,
        ]),
      )

    const doctorActions = h(
      'div',
      { className: 'rtkw-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'rtkw-action',
          disabled: snapshot.busy,
          'aria-busy': snapshot.busy ? 'true' : 'false',
          onClick: () => {
            void runDoctor()
          },
        },
        snapshot.busy ? t('panel.doctorRunning') : t('panel.doctor'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'rtkw-action',
          disabled: snapshot.doctor === undefined,
          onClick: clearDoctor,
        },
        t('panel.clearDoctor'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'rtkw-action',
          disabled: snapshot.doctor === undefined,
          onClick: () => {
            void copyDoctor()
          },
        },
        snapshot.doctorCopied
          ? t('panel.copied')
          : snapshot.doctorCopyFailed
            ? t('panel.copyFailed')
            : t('panel.copyDoctor'),
      ),
    )

    const diagnostics = h(
      'section',
      { className: 'rtkw-section', key: 'diagnostics', id: 'rtkw-diagnostics' },
      ...element([
        h('h4', null, t('panel.sectionDiagnostics')),
        snapshot.doctor === undefined || snapshot.doctorAt === undefined
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'rtkw-doctor-toggle',
                'aria-expanded': snapshot.doctorOpen ? 'true' : 'false',
                onClick: () => patch({ doctorOpen: !snapshot.doctorOpen }),
              },
              `${snapshot.doctorOpen ? '▾' : '▸'} ${doctorCollapsedLabel(t, snapshot.doctorAt, snapshot.doctorFailed)}`,
            ),
        doctorActions,
        snapshot.busy
          ? h('p', { className: 'rtkw-hint', role: 'status' }, t('panel.doctorRunningHint'))
          : null,
        snapshot.doctor === undefined || !snapshot.doctorOpen
          ? null
          : h('pre', { className: 'rtkw-doctor' }, snapshot.doctor),
      ]),
    )

    const feedback = h(
      'section',
      { className: 'rtkw-section', key: 'feedback' },
      ...element([
        h('h4', null, t('panel.sectionFeedback')),
        h(
          'div',
          { className: 'rtkw-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'rtkw-action',
              onClick: () => {
                void copyStatus()
              },
            },
            snapshot.copied
              ? t('panel.copied')
              : snapshot.copyFailed
                ? t('panel.copyFailed')
                : t('panel.copy'),
          ),
        ),
        h('p', { className: 'rtkw-hint' }, t('panel.copyHint')),
        h(
          'button',
          { type: 'button', className: 'rtkw-link', onClick: () => patch({ helpOpen: true }) },
          t('panel.help'),
        ),
      ]),
    )

    const helpBlock = (title: string, body: string): unknown =>
      h(
        'section',
        { className: 'rtkw-section' },
        h('h4', null, title),
        h('p', { className: 'rtkw-note' }, body),
      )

    const help = snapshot.helpOpen
      ? h(
          'div',
          {
            className: 'rtkw-overlay rtkw-help-overlay',
            role: 'presentation',
            onClick: (event: { target: unknown; currentTarget: unknown }) => {
              if (event.target === event.currentTarget) patch({ helpOpen: false })
            },
          },
          h(
            'div',
            {
              className: 'rtkw-panel rtkw-help',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('panel.helpTitle'),
            },
            ...element([
              h(
                'header',
                { className: 'rtkw-head' },
                h('strong', null, t('panel.helpTitle')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'rtkw-close',
                    'aria-label': t('panel.close'),
                    onClick: () => patch({ helpOpen: false }),
                  },
                  '✕',
                ),
              ),
              helpBlock(t('panel.helpCheckTitle'), t('panel.helpCheck')),
              helpBlock(t('panel.helpJsonTitle'), t('panel.helpJson')),
              helpBlock(t('panel.helpFailuresTitle'), t('panel.helpFailures')),
              h('p', { className: 'rtkw-fine' }, t('panel.helpClosing')),
            ]),
          ),
        )
      : null

    // Numbers first and together: health, session, lifetime, by-tool and recent
    // events. Diagnostics and export are utilities at the bottom; the health
    // section carries a shortcut that scrolls down to them.
    const sectionNodes = sections.map((section, index) => sectionNode(section, index))
    return h(
      'div',
      {
        className: 'rtkw-overlay',
        role: 'presentation',
        onClick: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) closePanel()
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
              {
                type: 'button',
                className: 'rtkw-close',
                'aria-label': t('panel.close'),
                onClick: closePanel,
              },
              '✕',
            ),
          ),
          ...sectionNodes,
          diagnostics,
          feedback,
          h('p', { className: 'rtkw-fine' }, t('panel.footnote')),
        ]),
      ),
      help,
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
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: ID,
            order: 2,
            locale: NS,
            // Session-scoped slot: the host re-runs this factory with the new
            // sessionId on every session switch, which is the signal the pill
            // needs to stop showing the previous session's numbers.
            inject: (sessionId: string | undefined) => {
              setCurrentSessionKey(sessionId)
              return {}
            },
          },
          Pill,
        ),
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
