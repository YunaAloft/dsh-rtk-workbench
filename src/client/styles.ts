/**
 * Browser stylesheet for the composer pill and its overlay.
 *
 * Kept in its own module so the issue #17 regression test can exercise the
 * injection path without importing the React entry point (which registers the
 * plugin when a page module loader is present).
 */

const CSS = `
.rtkw-pill{display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:var(--dsw-radius-sm);padding:1px 8px;font-size:12px;line-height:18px;cursor:pointer;min-width:0;max-width:min(340px,100%);overflow:hidden}
.rtkw-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rtkw-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.rtkw-pill:not([data-split]){flex-shrink:0}
.rtkw-icon{width:14px;height:14px;flex:none;color:var(--dsw-alias-label-tertiary);fill:currentColor}
.rtkw-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.rtkw-warn .rtkw-dot{background:var(--dsw-alias-state-warn-primary)}
.rtkw-off .rtkw-dot{background:var(--dsw-alias-state-idle-primary)}
.rtkw-primary{display:inline-flex;align-items:center;min-width:0;overflow:hidden;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.rtkw-saved{min-width:0;overflow:hidden;text-overflow:ellipsis}
.rtkw-sep{flex:none;margin:0 6px;color:var(--dsw-alias-separator-primary)}
.rtkw-pct{flex:none}
.rtkw-secondary{color:var(--dsw-alias-label-tertiary);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:767px){.rtkw-secondary{display:none}}
@media (max-width:480px){.rtkw-sep,.rtkw-pct{display:none}}
@media (max-width:360px){.rtkw-pill[data-split] .rtkw-primary{display:none}}
.rtkw-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;background:var(--dsw-alias-bg-mask-1);padding:24px}
.rtkw-help-overlay{z-index:61}
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
.rtkw-note{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:pre-line}
.rtkw-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.rtkw-link{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 0;cursor:pointer;text-align:left}
.rtkw-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.rtkw-help{max-width:560px}
.rtkw-help .rtkw-note{color:var(--dsw-alias-label-secondary);line-height:1.55}
.rtkw-action{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.rtkw-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rtkw-action:disabled{opacity:.6;cursor:default}
.rtkw-hint{flex:1 1 100%;margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}
.rtkw-fine{flex:1 1 100%;margin:6px 0 0;color:var(--dsw-alias-label-caption);font-size:11px}
.rtkw-doctor-toggle{display:block;width:100%;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:left;padding:6px 0 0;cursor:pointer;font-variant-numeric:tabular-nums}
.rtkw-doctor-toggle:hover{color:var(--dsw-alias-label-secondary)}
.rtkw-doctor{margin:8px 0 0;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:pre-wrap;max-height:200px;overflow:auto}
`

let stylesInjected = false

/**
 * Inject the stylesheet once, or refresh the stylesheet an earlier bundle left
 * behind. A hot update keeps the page alive: the new module runs with fresh
 * code but the old `<style>` element is still in the document. Returning early
 * there used to leave the new markup paired with stale CSS (issue #17).
 *
 * Exported so the regression test can drive the same path the client entry
 * uses; the entry itself registers the plugin for its side effect only.
 */
export function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  const id = 'rtk-workbench-styles'
  const existing = document.getElementById(id)
  if (existing !== null) {
    existing.textContent = CSS
    stylesInjected = true
    return
  }
  const style = document.createElement('style')
  style.id = id
  style.textContent = CSS
  document.head.appendChild(style)
  stylesInjected = true
}
