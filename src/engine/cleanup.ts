/**
 * Local evidence cleanup — deletes screenshot files/folders produced by
 * broker runs when the owning identity is deleted.
 *
 * SECURITY: every path is resolved and jailed under data/evidence before
 * deletion. No user input can ever make this remove a file outside the
 * evidence directory.
 */
import { rmSync, statSync } from "node:fs"
import { resolve, join } from "node:path"

/** Evidence root — honors PJ_DATA_DIR (same override as the store) so tests
 *  jail against the same root the store writes to. */
function evidenceRoot(): string {
  const dataDir = process.env.PJ_DATA_DIR ?? join(process.cwd(), "data")
  return resolve(dataDir, "evidence")
}

/** True if target is strictly INSIDE the evidence root (never the root
 *  itself — one bad path must never nuke the whole evidence tree). */
function isJailed(target: string): boolean {
  const root = evidenceRoot()
  const resolved = resolve(target)
  return resolved.startsWith(root + "\\") || resolved.startsWith(root + "/")
}

/**
 * Remove one evidence path — a .png file or a run directory. Missing paths
 * are fine (idempotent). Returns true if something was removed.
 */
export function removeEvidencePath(path: string): boolean {
  if (!path) return false
  const resolved = resolve(path)
  if (!isJailed(resolved)) {
    console.warn(`[cleanup] refusing to delete outside data/evidence: ${path}`)
    return false
  }
  try {
    statSync(resolved)
  } catch {
    return false // already gone
  }
  try {
    rmSync(resolved, { recursive: true, force: true })
    return true
  } catch (err) {
    console.warn(`[cleanup] failed to delete ${resolved}:`, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Delete every evidence path collected by store.deleteIdentity/resetAll.
 * Some paths are files inside run dirs that get removed with their parent —
 * dedupe by prefix so we don't double-work. Returns count removed.
 */
export function removeEvidencePaths(paths: string[]): number {
  const sorted = [...new Set(paths.map((p) => resolve(p)))].sort()
  let removed = 0
  const gone: string[] = []

  for (const p of sorted) {
    // skip if an already-deleted ancestor covered it
    if (gone.some((g) => p.startsWith(g + "\\") || p.startsWith(g + "/"))) continue
    if (removeEvidencePath(p)) {
      removed++
      gone.push(p)
    }
  }
  return removed
}
