/**
 * Local evidence cleanup — deletes screenshot files/folders produced by
 * broker runs when the owning identity is deleted.
 *
 * SECURITY: every path is jailed under data/evidence before deletion, and
 * the jail compares physical locations — a symlinked directory inside the
 * evidence tree cannot be used to reach a file outside it.
 */
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { getEvidenceDir, isInsideEvidenceDir } from "../config/paths.ts"

/** Resolve symlinks in every component but the last. The jail must see where
 *  a path really lands, while rmSync still removes a final symlink itself
 *  rather than whatever it points to. */
function physicalPath(target: string): string | undefined {
  try {
    return join(realpathSync(dirname(target)), basename(target))
  } catch {
    return undefined
  }
}

/** True if target is strictly INSIDE the evidence root (never the root
 *  itself — one bad path must never nuke the whole evidence tree). */
function isJailed(target: string): boolean {
  const physical = physicalPath(resolve(target))
  return physical !== undefined && isInsideEvidenceDir(physical)
}

/**
 * Remove one evidence path — a .png file or a run directory. Missing paths
 * are fine (idempotent). Returns true if something was removed.
 */
export function removeEvidencePath(path: string): boolean {
  if (!path) return false
  const resolved = resolve(path)
  try {
    // lstat, not stat: a dangling symlink still exists and can be removed.
    lstatSync(resolved)
  } catch {
    return false // already gone
  }
  if (!isJailed(resolved)) {
    console.warn(`[cleanup] refusing to delete outside data/evidence: ${path}`)
    return false
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

/**
 * Every entry directly under the evidence root. "Reset all" promises to delete
 * all evidence, and after it the database references nothing — so anything
 * still here lost its reference (a failed session, a legacy row) and would
 * never be found by reference-based cleanup. Each entry still passes the jail.
 */
export function listEvidenceEntries(): string[] {
  const root = getEvidenceDir()
  try {
    return readdirSync(root).map((name) => join(root, name))
  } catch {
    return []
  }
}
