/**
 * Orchestration: ties the store, Solari sessions, and broker adapters into
 * the user-facing flows. Every broker interaction runs inside a recorded
 * stealth session and files evidence (screenshots + replay URLs) into the
 * store, so every action is auditable later.
 */
import type { Identity, Listing, ScanRun } from "@/types"
import { adapters, getAdapter } from "@/adapters/registry"
import * as store from "@/store"
import { withBrokerSession, getReplayUrl } from "./solari.ts"

// ── scan ────────────────────────────────────────────────────────────────────

export async function runScan(identityId: string): Promise<ScanRun> {
  const identity = store.getIdentity(identityId)
  if (!identity) throw new Error(`identity ${identityId} not found`)

  const run = store.createScanRun(identityId)

  for (const adapter of adapters) {
    try {
      const { result: listings, evidence } = await withBrokerSession(
        `scan-${adapter.id}`,
        async (page) => {
          const found = await adapter.scan(page, identity)
          // Screenshot the first listing page as evidence.
          if (found.length > 0) {
            await page.screenshot({ fullPage: true }).then((png) => {
              evidence.screenshot("scan-result", png)
            }).catch(() => {})
          }
          return found
        },
      )

      // Save / refresh listings (dedupe by broker + url).
      const existing = store.listListings(identityId)
      for (const listing of listings) {
        const prior = existing.find((e) => e.brokerId === listing.brokerId && e.url === listing.url)
        if (prior) {
          store.upsertListing({ ...listing, id: prior.id, confirmedMine: prior.confirmedMine, firstSeenAt: prior.firstSeenAt })
        } else {
          listing.screenshotPath = evidence.evidenceDir // folder holding run pngs
          store.upsertListing(listing)
        }
      }

      run.results.push({ brokerId: adapter.id, ok: true, listingsFound: listings.length })
    } catch (err) {
      run.results.push({
        brokerId: adapter.id,
        ok: false,
        listingsFound: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  store.finishScanRun(run)
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
  const identity = store.getIdentity(listing.identityId)
  if (!identity) throw new Error(`identity ${listing.identityId} not found`)
  const adapter = getAdapter(listing.brokerId)

  const { result, evidence } = await withBrokerSession(`optout-${adapter.id}`, async (page) => {
    return adapter.prepareOptOut(page, listing, identity, contactEmail)
  })

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

export interface RescanDiff {
  removed: Array<{ listingId: string; brokerId: string }>
  stillListed: Array<{ listingId: string; brokerId: string }>
  relisted: Array<{ listingId: string; brokerId: string }>
  newFindings: Array<{ listingId: string; brokerId: string }>
}

/** Re-run scans and diff against stored listings. */
export async function runRescan(identityId: string): Promise<RescanDiff> {
  const identity = store.getIdentity(identityId)
  if (!identity) throw new Error(`identity ${identityId} not found`)

  const before = store.listListings(identityId)
  const confirmed = before.filter((l) => l.confirmedMine === true)
  const beforeUrls = new Set(confirmed.map((l) => `${l.brokerId}::${l.url}`))

  await runScan(identityId)

  const after = store.listListings(identityId)
  const afterUrls = new Set(after.map((l) => `${l.brokerId}::${l.url}`))

  const diff: RescanDiff = { removed: [], stillListed: [], relisted: [], newFindings: [] }

  for (const l of confirmed) {
    const key = `${l.brokerId}::${l.url}`
    const entry = { listingId: l.id, brokerId: l.brokerId }
    const subs = store.listSubmissions(l.id)
    const sub = subs[0]
    if (afterUrls.has(key)) {
      if (sub?.status === "confirmed" || sub?.status === "removed") {
        diff.relisted.push(entry)
        if (sub) store.updateSubmission(sub.id, { status: "submitted" })
      } else {
        diff.stillListed.push(entry)
      }
    } else {
      diff.removed.push(entry)
      if (sub) store.updateSubmission(sub.id, { status: "removed", removedVerifiedAt: new Date().toISOString() })
    }
  }

  for (const l of after) {
    const key = `${l.brokerId}::${l.url}`
    if (!beforeUrls.has(key)) diff.newFindings.push({ listingId: l.id, brokerId: l.brokerId })
  }

  return diff
}

export type { Identity, Listing }
