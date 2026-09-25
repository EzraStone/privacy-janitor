import { realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

/** Single source of truth for every local runtime-data path. */
export function getDataDir(): string {
  const configured = process.env.PJ_DATA_DIR?.trim()
  // Runtime data must be resolved on the user's machine, never traced into a build.
  return resolve(/* turbopackIgnore: true */ configured || join(process.cwd(), "data"))
}

export function getDatabasePath(): string {
  return join(getDataDir(), "privacy-janitor.db")
}

export function getEvidenceDir(): string {
  return join(getDataDir(), "evidence")
}

/**
 * True if `physical` — a path whose symlinks the caller has already resolved —
 * lies strictly inside the evidence directory, never the directory itself.
 * Both sides are compared physically, so a symlinked data root (macOS /var is
 * /private/var) still matches, and a symlink planted inside the evidence tree
 * cannot reach outside it.
 */
export function isInsideEvidenceDir(physical: string): boolean {
  let root: string
  try {
    root = realpathSync(getEvidenceDir())
  } catch {
    return false
  }
  const child = relative(root, physical)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
