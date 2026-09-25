/**
 * Orchestration: ties the store, Solari sessions, and broker adapters into
 * the user-facing flows. Every broker interaction runs inside a recorded
 * stealth session and files evidence (screenshots + replay URLs) into the
 * store, so every action is auditable later.
 */
import type { BrokerAdapter, Identity, Listing, ScanBrokerResult, ScanKind, ScanRun } from "../types.ts"
import { adapters, getAdapter } from "../adapters/registry.ts"
import * as store from "../store/index.ts"
import { withBrokerSession } from "./solari.ts"

// ── scan ────────────────────────────────────────────────────────────────────

type OrchestratorGlobal = typeof globalThis & {
  __pjActiveScans?: Map<string, Promise<void>>
}

const orchestratorGlobal = globalThis as OrchestratorGlobal
const activeScans = orchestratorGlobal.__pjActiveScans ??= new Map()

/** Queue a scan and reuse an unfinished run instead of starting a duplicate. */
export function startScan(
  identityId: string,
  kind: ScanKind = "scan",
): { run: ScanRun; resumed: boolean; conflict: boolean } {
  if (!store.getIdentity(identityId)) throw new Error(`identity ${identityId} not found`)
  const existing = store.listScanRuns(identityId).find((run) => !run.finishedAt)
  const run = existing ?? store.createScanRun(identityId, kind)
  if (existing && existing.kind !== kind) {
    return { run, resumed: false, conflict: true }
  }
  scheduleScan(run)
  return { run, resumed: Boolean(existing), conflict: false }
}

/** Restart unfinished scans when the local app is opened after an interruption. */
export function resumeIncompleteScans(): void {
  const newestByIdentity = new Set<string>()
  for (const run of store.listScanRuns().filter((candidate) => !candidate.finishedAt)) {
    if (newestByIdentity.has(run.identityId)) {
      // Older unfinished rows came from a previous process; keep one canonical run.
      store.finishScanRun(run)
      continue
    }
    newestByIdentity.add(run.identityId)
    if (store.getIdentity(run.identityId)) scheduleScan(run)
    else store.finishScanRun(run)
  }
}

function scheduleScan(run: ScanRun): void {
  if (activeScans.has(run.id)) return
  const task = runScan(run.identityId, run.id)
    .catch((err) => {
      console.error(`[scan] ${run.id} stopped:`, err)
    })
    .finally(() => {
      activeScans.delete(run.id)
    })
  activeScans.set(run.id, task)
}

/** Injected in tests so a scan can run without a provider or live brokers. */
export type ScanDependencies = {
  withSession?: typeof withBrokerSession
  brokers?: BrokerAdapter[]
}

export async function runScan(
  identityId: string,
  resumeRunId?: string,
  kind: ScanKind = "scan",
  dependencies: ScanDependencies = {},
): Promise<ScanRun> {
  const withSession = dependencies.withSession ?? withBrokerSession
  const brokers = dependencies.brokers ?? adapters
  const identity = store.getIdentity(identityId)
  if (!identity) throw new Error(`identity ${identityId} not found`)

  const run = resumeRunId ? store.getScanRun(resumeRunId) : store.createScanRun(identityId, kind)
  if (!run || run.identityId !== identityId) {
    throw new Error(`scan ${resumeRunId ?? "unknown"} not found for identity ${identityId}`)
  }
  if (run.finishedAt) return run
  const completedBrokers = new Set(run.results.map((result) => result.brokerId))

  for (const adapter of brokers) {
    if (completedBrokers.has(adapter.id)) continue
    // The user may delete the profile while a remote broker session is running.
    if (!store.getIdentity(identityId) || !store.getScanRun(run.id)) return run

    let checkpointed = false
    try {
      const { result: observation, evidence } = await withSession(
        `scan-${adapter.id}`,
        async (page, runEvidence) => {
          const result = await adapter.scan(page, identity)
          // Adapters capture the result page before navigating into profiles.
          // Keep a last-page fallback only if that evidence capture failed.
          const screenshot = result.searchScreenshot ??
            await page.screenshot({ fullPage: true }).catch(() => undefined)
          if (screenshot) runEvidence.screenshot("scan-result-state", screenshot)
          return result
        },
      )

      const brokerResult: ScanBrokerResult = {
        brokerId: adapter.id,
        ok: observation.outcome !== "inconclusive",
        outcome: observation.outcome,
        listingsFound: observation.listings.length,
        issueCode: observation.issueCode,
        error: observation.detail,
        evidenceDir: evidence.evidenceDir,
      }
      const events = store.recordBrokerScanObservation({
        identityId,
        brokerId: adapter.id,
        runKind: run.kind,
        observation,
        evidenceDir: evidence.evidenceDir,
        runId: run.id,
        result: brokerResult,
      })
      run.events.push(...events)
      run.results.push(brokerResult)
      checkpointed = true
    } catch (err) {
      run.results.push({
        brokerId: adapter.id,
        ok: false,
        outcome: "inconclusive",
        listingsFound: 0,
        issueCode: "unknown",
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // A crash after this point resumes at the next broker, not from scratch.
    if (!checkpointed && !store.saveScanRunProgress(run)) return run
  }

  if (store.getScanRun(run.id)) store.finishScanRun(run)
  return run
}

// Opt-out workers live in optouts.ts; scans share the same local store.

// ── rescan + diff ───────────────────────────────────────────────────────────

/** Run a synchronous rescan for CLI/tests; the UI uses startScan(..., "rescan"). */
export function runRescan(identityId: string): Promise<ScanRun> {
  return runScan(identityId, undefined, "rescan")
}

export type { Identity, Listing }
