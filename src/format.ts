/**
 * Human-readable number formatting shared by the host and the browser half.
 *
 * Kept free of Node imports so the client bundle can use the same functions:
 * a size or token count must read identically in `/rtk stats` and on the pill.
 *
 * @module dsh-rtk-workbench/format
 */

/**
 * Human byte size, one decimal for KB and above.
 *
 * @param bytes - byte count.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
