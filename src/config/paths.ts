import { join, resolve } from "node:path"

/** Single source of truth for every local runtime-data path. */
export function getDataDir(): string {
  const configured = process.env.PJ_DATA_DIR?.trim()
  return resolve(configured || join(process.cwd(), "data"))
}

export function getDatabasePath(): string {
  return join(getDataDir(), "privacy-janitor.db")
}

export function getEvidenceDir(): string {
  return join(getDataDir(), "evidence")
}
