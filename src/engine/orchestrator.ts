/**
 * Orchestration: ties the store, Solari sessions, and broker adapters into
 * the user-facing flows. Every broker interaction runs inside a recorded
 * stealth session and files evidence (screenshots + replay URLs) into the
 * store, so every action is auditable later.
 */
import type { Identity, Listing, ScanBrokerResult, ScanKind, ScanRun } from "../types.ts"
import { adapters, getAdapter } from "../adapters/registry.ts"
import * as store from "../store/index.ts"
import { createProxySessionId, withBrokerSession, getReplayUrl } from "./solari.ts"

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

export async function runScan(
  identityId: string,
  resumeRunId?: string,
  kind: ScanKind = "scan",
): Promise<ScanRun> {
  const identity = store.getIdentity(identityId)
  if (!identity) throw new Error(`identity ${identityId} not found`)

  const run = resumeRunId ? store.getScanRun(resumeRunId) : store.createScanRun(identityId, kind)
  if (!run || run.identityId !== identityId) {
    throw new Error(`scan ${resumeRunId ?? "unknown"} not found for identity ${identityId}`)
  }
  if (run.finishedAt) return run
  const completedBrokers = new Set(run.results.map((result) => result.brokerId))

  for (const adapter of adapters) {
    if (completedBrokers.has(adapter.id)) continue
    // The user may delete the profile while a remote broker session is running.
    if (!store.getIdentity(identityId) || !store.getScanRun(run.id)) return run

    let checkpointed = false
    try {
      const { result: observation, evidence } = await withBrokerSession(
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

// ── opt-out: prepare -> approve -> submit ───────────────────────────────────

/** Contact email is whatever the user wants brokers to see; collected in UI. */
export async function prepareListingOptOut(
  listingId: string,
  contactEmail: string,
): Promise<{ previewPath: string; summary: string }> {
  const listing = store.getListing(listingId)
  if (!listing) throw new Error(`listing ${listingId} not found`)
  assertListingPresent(listing)
  const identity = store.getIdentity(listing.identityId)
  if (!identity) throw new Error(`identity ${listing.identityId} not found`)
  const adapter = getAdapter(listing.brokerId)
  const stickySessionId = createProxySessionId(`optout-${adapter.id}`)

  const { result, evidence } = await withBrokerSession(
    `optout-${adapter.id}`,
    async (page) => adapter.prepareOptOut(page, listing, identity, contactEmail),
    { proxySessionId: stickySessionId },
  )

  const previewPath = evidence.screenshot("optout-preview", result.screenshot)
  const replay = evidence.sessionId ? await getReplayUrl(evidence.sessionId).catch(() => undefined) : undefined

  // Persist the prepared state so submit can resume in a fresh session.
  store.savePreparedOptOut({
    listingId,
    brokerId: adapter.id,
    state: {
      contactEmail,
      previewPath,
      replayUrl: replay ?? "",
      sessionEvidenceDir: evidence.evidenceDir,
      proxySessionId: evidence.proxySessionId,
    },
    createdAt: new Date().toISOString(),
  })

  const sub = store.createSubmission(listingId)
  store.updateSubmission(sub.id, {
    status: "prepared",
    previewScreenshotPath: previewPath,
  })

  return { previewPath, summary: result.summary }
}

/** Submit only after user approval. Re-drives the form, then clicks submit. */
export async function submitApprovedOptOut(listingId: string): Promise<void> {
  const prepared = store.getPreparedOptOut(listingId)
  if (!prepared) throw new Error("nothing prepared for this listing — prepare first")
  const listing = store.getListing(listingId)
  if (!listing) throw new Error(`listing ${listingId} not found`)
  assertListingPresent(listing)
  const identity = store.getIdentity(listing.identityId)
  if (!identity) throw new Error(`identity ${listing.identityId} not found`)
  const adapter = getAdapter(listing.brokerId)

  const subs = store.listSubmissions(listingId)
  const sub = subs[0]
  if (!sub) throw new Error("no submission record — prepare first")

  store.updateSubmission(sub.id, { status: "approved", incrementAttempts: true })

  try {
    const { result, evidence } = await withBrokerSession(
      `submit-${adapter.id}`,
      async (page) => {
        // Re-drive the form to the filled state (fresh session), then submit.
        await adapter.prepareOptOut(page, listing, identity, prepared.state.contactEmail)
        return adapter.submitOptOut(page, prepared)
      },
      { proxySessionId: prepared.state.proxySessionId },
    )

    const resultPath = result.screenshot
      ? evidence.screenshot("optout-result", result.screenshot)
      : undefined

    store.updateSubmission(sub.id, {
      status: result.needsEmailConfirmation && adapter.expectsEmailConfirmation
        ? "awaiting_email"
        : "submitted",
      resultScreenshotPath: resultPath,
      submitSessionId: evidence.sessionId,
    })
    store.deletePreparedOptOut(listingId)
  } catch (err) {
    store.updateSubmission(sub.id, {
      status: "failed",
      lastError: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/** User pasted the confirmation link from their email; click it recorded. */
export async function confirmOptOutEmail(listingId: string, confirmationUrl: string): Promise<void> {
  const listing = store.getListing(listingId)
  if (!listing) throw new Error(`listing ${listingId} not found`)
  assertListingPresent(listing)
  const adapter = getAdapter(listing.brokerId)
  if (!adapter.confirmByEmail) throw new Error(`${adapter.name} flow has no email confirmation step`)

  const subs = store.listSubmissions(listingId)
  const sub = subs[0]
  if (!sub) throw new Error("no submission record")

  try {
    const { evidence } = await withBrokerSession(`confirm-${adapter.id}`, async (page) => {
      const confirm = adapter.confirmByEmail!
      await confirm(page, confirmationUrl)
      await page.screenshot({ fullPage: true }).then((png) => {
        evidence.screenshot("email-confirm-result", png)
      }).catch(() => {})
    })

    store.updateSubmission(sub.id, {
      status: "confirmed",
      confirmSessionId: evidence.sessionId,
      confirmEvidenceDir: evidence.evidenceDir,
    })
  } catch (err) {
    store.updateSubmission(sub.id, {
      status: "failed",
      lastError: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

// ── rescan + diff ───────────────────────────────────────────────────────────

/** Run a synchronous rescan for CLI/tests; the UI uses startScan(..., "rescan"). */
export function runRescan(identityId: string): Promise<ScanRun> {
  return runScan(identityId, undefined, "rescan")
}

function assertListingPresent(listing: Listing): void {
  if (listing.presenceStatus === "absent") {
    throw new Error("this listing is no longer visible; rescan before taking another broker action")
  }
}

export type { Identity, Listing }
