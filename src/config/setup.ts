import { closeSync, mkdirSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"
import { getDataDir } from "./paths.ts"
import { RequestValidationError } from "../security/requests.ts"

export type KeyStatus = "missing" | "placeholder" | "configured"
export interface SetupStatus {
  canStartScan: boolean
  node: { supported: boolean; version: string }
  solari: KeyStatus
  groq: KeyStatus
  storage: { writable: boolean; message: string }
  providerAccess: "not_checked"
}

/** Presence only, never an assertion that a provider has accepted the key. */
export function keyStatus(value: string | undefined): KeyStatus {
  const key = value?.trim()
  if (!key) return "missing"
  if (/^(?:slr_live_|gsk_)?x{3,}$/i.test(key) || /^(?:your[-_ ]|replace[-_ ]|changeme|<)/i.test(key)) return "placeholder"
  return "configured"
}

/** Creates and removes only a unique, emptyable probe directory under local storage. */
export function probeStorage(dataDir: string): SetupStatus["storage"] {
  let directory: string | undefined
  let path: string | undefined
  let descriptor: number | undefined
  let writable = false
  try {
    mkdirSync(dataDir, { recursive: true })
    directory = mkdtempSync(join(dataDir, ".pj-setup-"))
    path = join(directory, "probe")
    descriptor = openSync(/* turbopackIgnore: true */ path, "wx", 0o600)
    writeSync(descriptor, "local storage check")
    closeSync(descriptor)
    descriptor = undefined
    unlinkSync(path)
    path = undefined
    rmdirSync(directory)
    directory = undefined
    writable = true
  } catch {
    // Do not expose environment paths or filesystem error payloads in API responses.
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch {} }
    if (path) { try { unlinkSync(path) } catch {} }
    if (directory) { try { rmdirSync(directory) } catch {} }
  }
  return {
    writable,
    message: writable ? "Local data folder is writable." : "Cannot write local data. Check folder permissions or set PJ_DATA_DIR to a writable private folder, then restart.",
  }
}

/** The only variables setup reads. Narrower than NodeJS.ProcessEnv, which
 *  Next.js augments to require NODE_ENV, so callers can pass just these keys. */
export type SetupEnv = { SOLARI_API_KEY?: string; GROQ_API_KEY?: string }

export function getSetupStatus(options: {
  env?: SetupEnv
  nodeVersion?: string
  storageProbe?: () => SetupStatus["storage"]
} = {}): SetupStatus {
  const env = options.env ?? process.env
  const version = options.nodeVersion ?? process.versions.node
  const supported = /^\d+\./.test(version) && Number(version.split(".")[0]) >= 24
  const solari = keyStatus(env.SOLARI_API_KEY)
  const groq = keyStatus(env.GROQ_API_KEY)
  const storage = (options.storageProbe ?? (() => probeStorage(getDataDir())))()
  return { canStartScan: supported && solari === "configured" && storage.writable, node: { supported, version }, solari, groq, storage, providerAccess: "not_checked" }
}

export function requireScanSetup(): void {
  const status = getSetupStatus()
  if (!status.node.supported) throw new RequestValidationError("Node.js 24 or newer is required. Update Node and restart the app.", 503)
  if (!status.storage.writable) throw new RequestValidationError(status.storage.message, 503)
  if (status.solari !== "configured") throw new RequestValidationError("Add your SOLARI_API_KEY to .env and restart the app before scanning or preparing a removal.", 503)
}
