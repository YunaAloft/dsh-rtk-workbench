/**
 * Pure view model for the composer pill and its overlay.
 *
 * Kept free of React and of the host's client services so the pieces that decide
 * what a user reads — tone, headline, panel rows — stay unit-testable under
 * plain Node. The component file only renders what these functions return.
 *
 * @module dsh-rtk-workbench/client/model
 */

import { formatBytes } from '../format'
import { formatTokens } from '../tokens'

/** Visual state of the pill. */
export type Tone = 'ok' | 'warn' | 'off'

/** One tool row of the session breakdown. */
export interface ToolRow {
  readonly name: string
  readonly calls: number
  readonly inBytes: number
  readonly outBytes: number
  readonly savedTokens: number
}

/** One observed result. */
export interface EventRow {
  readonly at: number
  readonly tool: string
  readonly kind: 'compress' | 'skip'
  readonly reason?: string
  readonly savedTokens?: number
  readonly ratio?: number
}

/** One session, as served by `GET /status`. */
export interface SessionView {
  /** Session key the host counted these numbers under. */
  readonly key: string
  readonly compressions: number
  readonly inBytes: number
  readonly outBytes: number
  readonly savedTokens: number
  readonly ms: number
  readonly ratio: number
  /** Applied rewrites for this session (persisted across restarts). */
  readonly rewrites: number
  readonly skipped: Readonly<Record<string, number>>
  readonly byTool: readonly ToolRow[]
  readonly recent: readonly EventRow[]
}

/** Cross-restart totals. */
export interface LifetimeView {
  readonly compressions: number
  readonly inBytes: number
  readonly outBytes: number
  readonly savedTokens: number
  readonly rewrites: number
  readonly fallbacks: number
  readonly guards: number
  readonly updatedAt: string
}

/** The status document, normalized. */
export interface StatusView {
  readonly updatedAt: string
  readonly binary: { readonly source: string; readonly version: string }
  readonly probe: { readonly state: string; readonly detail: string }
  readonly pipeline: { readonly mode: string; readonly health: string; readonly detail?: string }
  readonly switches: {
    readonly rewrite: boolean
    readonly compress: boolean
    readonly awareness: boolean
    readonly guard: string
    readonly deny: boolean
    readonly ui: boolean
  }
  readonly rewrites: {
    readonly calls: number
    readonly fallbacks: number
    readonly guards: number
    readonly learned: readonly string[]
  }
  readonly session: SessionView | null
  readonly lifetime: LifetimeView | null
  readonly patched: readonly string[]
  readonly persist: { readonly enabled: boolean }
}

/** Translator injected by the host locale seat. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function sessionOf(value: unknown): SessionView | null {
  if (value === null || typeof value !== 'object') return null
  const raw = record(value)
  const skipped: Record<string, number> = {}
  for (const [key, count] of Object.entries(record(raw.skipped))) skipped[key] = num(count)
  const byTool = Array.isArray(raw.byTool)
    ? raw.byTool.map((row) => {
        const entry = record(row)
        return {
          name: str(entry.name, 'tool'),
          calls: num(entry.calls),
          inBytes: num(entry.inBytes),
          outBytes: num(entry.outBytes),
          savedTokens: num(entry.savedTokens),
        }
      })
    : []
  const recent = Array.isArray(raw.recent)
    ? raw.recent.map((row) => {
        const entry = record(row)
        return {
          at: num(entry.at),
          tool: str(entry.tool, 'tool'),
          kind: entry.kind === 'skip' ? ('skip' as const) : ('compress' as const),
          ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
          ...(typeof entry.savedTokens === 'number' ? { savedTokens: entry.savedTokens } : {}),
          ...(typeof entry.ratio === 'number' ? { ratio: entry.ratio } : {}),
        }
      })
    : []
  return {
    key: str(raw.key),
    compressions: num(raw.compressions),
    inBytes: num(raw.inBytes),
    outBytes: num(raw.outBytes),
    savedTokens: num(raw.savedTokens),
    ms: num(raw.ms),
    ratio: num(raw.ratio),
    rewrites: num(raw.rewrites),
    skipped,
    byTool,
    recent,
  }
}

function lifetimeOf(value: unknown): LifetimeView | null {
  if (value === null || typeof value !== 'object') return null
  const raw = record(value)
  return {
    compressions: num(raw.compressions),
    inBytes: num(raw.inBytes),
    outBytes: num(raw.outBytes),
    savedTokens: num(raw.savedTokens),
    rewrites: num(raw.rewrites),
    fallbacks: num(raw.fallbacks),
    guards: num(raw.guards),
    updatedAt: str(raw.updatedAt, ''),
  }
}

/**
 * Normalize one `GET /status` document.
 *
 * @param input - parsed JSON (unknown on purpose: the route is the boundary).
 * @returns the view, or `undefined` when the document is not one of ours.
 */
export function readStatus(input: unknown): StatusView | undefined {
  const raw = record(input)
  if (raw.ok !== true) return undefined
  const binary = record(raw.binary)
  const probe = record(raw.probe)
  const pipeline = record(raw.pipeline)
  const switches = record(raw.switches)
  const rewrites = record(raw.rewrites)
  return {
    updatedAt: str(raw.updatedAt),
    binary: { source: str(binary.source, 'unknown'), version: str(binary.version) },
    probe: { state: str(probe.state, 'unknown'), detail: str(probe.detail) },
    pipeline: {
      mode: str(pipeline.mode),
      health: str(pipeline.health, 'unknown'),
      ...(typeof pipeline.detail === 'string' ? { detail: pipeline.detail } : {}),
    },
    switches: {
      rewrite: bool(switches.rewrite),
      compress: bool(switches.compress),
      awareness: bool(switches.awareness),
      guard: str(switches.guard, 'enforce'),
      deny: bool(switches.deny),
      ui: bool(switches.ui, true),
    },
    rewrites: {
      calls: num(rewrites.calls),
      fallbacks: num(rewrites.fallbacks),
      guards: num(rewrites.guards),
      learned: Array.isArray(rewrites.learned) ? rewrites.learned.filter((word) => typeof word === 'string') : [],
    },
    session: sessionOf(raw.session),
    lifetime: lifetimeOf(raw.lifetime),
    patched: Array.isArray(raw.patched) ? raw.patched.filter((name) => typeof name === 'string') : [],
    persist: { enabled: bool(record(raw.persist).enabled) },
  }
}

/**
 * Which visual state the pill is in.
 *
 * `off` means "not doing anything", `warn` means "something the user should
 * look at": rtk unusable, a pipeline that fell back, or a failed fetch.
 *
 * @param view - last good document, if any.
 * @param error - last fetch error, if the most recent attempt failed.
 */
export function toneOf(view: StatusView | undefined, error: string | undefined): Tone {
  // With no document at all there are no numbers to warn about: a failed first
  // fetch is an unavailable gray pill, not a stale-data warning. Once a
  // document exists, a failed refresh warns that the visible numbers are stale.
  if (view === undefined) return 'off'
  if (error !== undefined) return 'warn'
  if (view.probe.state === 'fail') return 'warn'
  // Compression is where the savings come from; with it off the pill must not
  // keep showing a healthy green dot over a frozen number.
  if (!view.switches.compress) return 'off'
  if (view.pipeline.health === 'problems') return 'warn'
  return 'ok'
}

/** Whole percentage, 0–100, for one 0–1 ratio. */
function percentOf(ratio: number): number {
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100)
}

/**
 * Reduction indicator for the pill and the event list.
 *
 * A leading minus (`-39%`) reads as a loss next to "saved 12.4k token", and the
 * ASCII hyphen does not match the typographic minus the docs use. A downward
 * arrow states the direction without either problem.
 *
 * @param ratio - fraction of bytes that did not reach the model, 0–1.
 */
export function reduction(ratio: number): string {
  return `↓${String(percentOf(ratio))}%`
}

/**
 * Whether the pill should be on screen at all.
 *
 * Hidden until the first document arrives (no flicker of a fake "ready"),
 * except when the first fetch failed: then a gray unavailable pill is the only
 * signal that the plugin is present but its status route is unreachable.
 * Hidden when `/rtk off ui` or `uiPill: false` asked for it.
 *
 * @param view - last good document.
 * @param error - last fetch error, if any.
 */
export function pillVisible(view: StatusView | undefined, error?: string): boolean {
  if (view === undefined) return error !== undefined
  return view.switches.ui
}

/**
 * Whether the document's session section belongs to the session the user is
 * looking at. The host counts stats per `agent.id`; after a session switch the
 * pill must not keep showing the previous session's numbers, so a mismatch is
 * rendered as "loading", never as stale data. A document without a session
 * (nothing recorded yet) and a client that does not know its session id both
 * count as "not stale": there is no wrong number to show.
 *
 * @param view - last good document.
 * @param currentSessionKey - session id from the slot's `inject`, if known.
 */
export function sessionMatches(view: StatusView, currentSessionKey: string | undefined): boolean {
  if (view.session === null) return true
  if (currentSessionKey === undefined || currentSessionKey === '') return true
  return view.session.key === currentSessionKey
}

/** The two lines of the pill. */
export interface PillText {
  readonly primary: string
  readonly secondary: string
  /** 保存态的拆段：窄屏只保留第一段（saved），其余整段隐藏。 */
  readonly split?: {
    readonly saved: string
    readonly separator: string
    readonly reduction: string
  }
}

/**
 * Headline and detail line of the pill.
 *
 * The headline always names what the number means ("saved … token"), because a
 * bare `12.4k` next to a percentage reads like either usage or savings.
 *
 * @param view - last good document.
 * @param error - last fetch error, if any.
 * @param t - translator.
 * @param currentSessionKey - session id from the slot's `inject`, if known.
 */
export function pillText(
  view: StatusView | undefined,
  error: string | undefined,
  t: Translate,
  currentSessionKey?: string,
): PillText {
  if (error !== undefined) {
    return { primary: t('pill.offline'), secondary: t('pill.offlineDetail', { error }) }
  }
  if (view === undefined) return { primary: t('pill.loading'), secondary: '' }
  if (!sessionMatches(view, currentSessionKey)) return { primary: t('pill.loading'), secondary: '' }
  if (view.probe.state === 'fail') return { primary: t('pill.unavailable'), secondary: view.probe.detail }
  if (!view.switches.compress) return { primary: t('pill.compressOff'), secondary: '' }
  if (view.pipeline.health === 'problems') {
    return { primary: t('pill.degraded'), secondary: view.pipeline.detail ?? '' }
  }
  if (view.session === null || view.session.compressions === 0) {
    return { primary: t('pill.ready'), secondary: t('pill.readyDetail') }
  }
  const session = view.session
  const secondary = t('pill.detail', {
    calls: session.compressions,
    rewrites: session.rewrites,
  })
  const saved = t('pill.saved', { tokens: formatTokens(session.savedTokens) })
  const reductionText = reduction(session.ratio)
  return {
    primary: `${saved} · ${reductionText}`,
    secondary,
    split: { saved, separator: '·', reduction: reductionText },
  }
}

/** One row of the overlay. */
export interface PanelRow {
  readonly label: string
  readonly value: string
  readonly tone?: Tone
}

/** One section of the overlay. */
export interface PanelSection {
  readonly title: string
  readonly rows: readonly PanelRow[]
  readonly note?: string
}

/** Counts in a stable order, skipping zeros. */
function skips(view: SessionView): PanelRow[] {
  const order = ['size', 'scope', 'marked', 'payload', 'ptc']
  return order
    .filter((reason) => (view.skipped[reason] ?? 0) > 0)
    .map((reason) => ({ label: reason, value: String(view.skipped[reason] ?? 0) }))
}

/**
 * Everything the overlay renders, derived from one document.
 *
 * @param view - last good document.
 * @param error - last fetch error, if any.
 * @param t - translator.
 * @param currentSessionKey - session id from the slot's `inject`, if known.
 */
export function panelSections(
  view: StatusView | undefined,
  error: string | undefined,
  t: Translate,
  currentSessionKey?: string,
): PanelSection[] {
  if (view === undefined) {
    // Without a document the overlay has no health/session data; surfacing the
    // fetch error is the difference between "plugin broken" and "plugin not
    // installed" for someone who only sees the composer dock.
    return error === undefined
      ? [{ title: t('panel.loading'), rows: [] }]
      : [{ title: t('panel.health'), rows: [{ label: t('panel.error'), value: error, tone: 'warn' }] }]
  }
  const stale = !sessionMatches(view, currentSessionKey)
  const shorten = (key: string): string => (key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key)
  const health: PanelRow[] = [
    { label: t('panel.binary'), value: `${view.binary.source}${view.binary.version === '' ? '' : ` · ${view.binary.version}`}` },
    {
      label: t('panel.probe'),
      value: view.probe.state === 'ok' ? t('panel.ok') : view.probe.state === 'fail' ? t('panel.failed') : t('panel.unknown'),
      tone: view.probe.state === 'fail' ? 'warn' : 'ok',
    },
    {
      label: t('panel.pipeline'),
      value:
        view.pipeline.health === 'problems'
          ? `${view.pipeline.mode} · ${t('panel.pipelineProblems')}`
          : `${view.pipeline.mode} · ${t('panel.ok')}`,
      tone: view.pipeline.health === 'problems' ? 'warn' : 'ok',
    },
    {
      label: t('panel.switches'),
      value: `${t('panel.rewrite')}: ${view.switches.rewrite ? t('panel.on') : t('panel.off')} · ${t('panel.compress')}: ${view.switches.compress ? t('panel.on') : t('panel.off')}`,
    },
  ]
  if (currentSessionKey !== undefined && currentSessionKey !== '') {
    health.push(
      stale
        ? {
            label: t('panel.sessionKeys'),
            value: t('panel.sessionMismatch', {
              shown: shorten(view.session?.key ?? '—'),
              current: shorten(currentSessionKey),
            }),
            tone: 'warn',
          }
        : { label: t('panel.sessionKeys'), value: t('panel.sessionMatch') },
    )
  }
  if (error !== undefined) health.push({ label: t('panel.error'), value: error, tone: 'warn' })

  if (stale) {
    return [
      { title: t('panel.health'), rows: health },
      { title: t('panel.session'), rows: [{ label: t('panel.sessionLoading'), value: '' }] },
    ]
  }

  const session = view.session
  const sessionSection: PanelSection = {
    title: t('panel.session'),
    rows:
      session === null || session.compressions === 0
        ? [{ label: t('panel.none'), value: '' }]
        : [
            { label: t('panel.savedTokens'), value: `≈${formatTokens(session.savedTokens)} tok` },
            {
              label: t('panel.savedBytes'),
              value: `${formatBytes(session.inBytes)} → ${formatBytes(session.outBytes)} · ${t('panel.reduction')} ${String(percentOf(session.ratio))}%`,
            },
            {
              label: t('panel.calls'),
              value: t('panel.callsValue', {
                compressions: session.compressions,
                rewrites: session.rewrites,
                seconds: (session.ms / 1000).toFixed(1),
              }),
            },
            ...(view.rewrites.guards > 0
              ? [{ label: t('panel.guard'), value: String(view.rewrites.guards), tone: 'warn' as Tone }]
              : []),
          ],
    ...(session !== null && Object.values(session.skipped).some((count) => count > 0)
      ? { note: `${t('panel.skipped')}: ${skips(session)
          .map((row) => `${row.label} ${row.value}`)
          .join(' · ')}` }
      : {}),
  }

  const lifetimeSection: PanelSection = {
    title: t('panel.lifetime'),
    rows: view.persist.enabled
      ? view.lifetime === null || view.lifetime.compressions === 0
        ? [{ label: t('panel.nothingYet'), value: '' }]
        : [
            { label: t('panel.savedTokens'), value: `≈${formatTokens(view.lifetime.savedTokens)} tok` },
            {
              label: t('panel.calls'),
              value: t('panel.lifetimeValue', {
                compressions: view.lifetime.compressions,
                rewrites: view.lifetime.rewrites,
              }),
            },
          ]
      : [{ label: t('panel.persistenceOff'), value: '' }],
  }

  const byTool: PanelSection = {
    title: t('panel.byTool'),
    rows:
      session === null || session.byTool.length === 0
        ? [{ label: t('panel.none'), value: '' }]
        : session.byTool.slice(0, 8).map((row) => ({
            label: row.name,
            value: `${row.calls}× · ≈${formatTokens(row.savedTokens)} tok · ${formatBytes(row.inBytes)} → ${formatBytes(row.outBytes)}`,
          })),
  }

  const recent: PanelSection = {
    title: t('panel.recent'),
    rows:
      session === null || session.recent.length === 0
        ? [{ label: t('panel.none'), value: '' }]
        : session.recent.slice(-3).reverse().map((event) => ({
            label: new Date(event.at).toLocaleTimeString(),
            value:
              event.kind === 'compress'
                ? `${event.tool} · ${reduction(event.ratio ?? 0)}`
                : `${event.tool} · ${t('panel.skippedReason', { reason: event.reason ?? '?' })}`,
            tone: event.kind === 'compress' ? 'ok' : 'off',
          })),
  }

  return [{ title: t('panel.health'), rows: health }, sessionSection, lifetimeSection, byTool, recent]
}
