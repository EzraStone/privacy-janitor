import type { Identity, Listing, PreparedOptOut, Submission } from "../types.ts"
import * as store from "../store/index.ts"
import { getAdapter } from "../adapters/registry.ts"
import { createProxySessionId, withBrokerSession } from "./solari.ts"
import { validateBrokerConfirmationUrl } from "../security/requests.ts"

type Dependencies = {
  withSession?: typeof withBrokerSession
  adapterFor?: typeof getAdapter
}

function snapshot(listing: Listing, identity: Identity): string {
  return JSON.stringify({
    url: listing.url, broker: listing.brokerId, name: identity.fullName,
    city: identity.city, state: identity.stateCode, age: identity.ageRange,
    relatives: identity.relatives,
  })
}

function preparedContext(sub: Submission) {
  const listing = store.requireActionableListing(sub.listingId)
  const identity = store.getIdentity(listing.identityId)!
  const prepared = store.getPreparedOptOut(sub.listingId)
  if (!prepared || prepared.submissionId !== sub.id) throw new Error("prepare a new preview for this attempt")
  if (prepared.state.snapshot !== snapshot(listing, identity)) {
    throw new Error("profile or listing changed since the preview; cancel this attempt and prepare it again")
  }
  return { listing, identity, prepared }
}

/** Remote broker clicks cannot be made exactly-once. Persist the intent before
 * a click and require acknowledgement when a crash leaves its result unknown. */
export function createOptOutService(dependencies: Dependencies = {}) {
  const withSession = dependencies.withSession ?? withBrokerSession
  const adapterFor = dependencies.adapterFor ?? getAdapter
  const preparations = new Map<string, Promise<Submission>>()
  // Keyed per operation: a submit job stays registered while its browser
  // closes, after the receipt is saved. A confirm arriving in that window must
  // not be deduplicated against it — its URL exists only in memory.
  const jobs = new Map<string, { submissionId: string; done: Promise<void> }>()

  async function prepare(listingId: string, rawContactEmail: string): Promise<Submission> {
    store.requireActionableListing(listingId)
    const active = store.activeSubmission(listingId)
    if (active) return active
    const pending = preparations.get(listingId)
    if (pending) return pending
    // Normalize before validating: API callers don't get the browser's
    // type="email" whitespace stripping that the dashboard relies on.
    const contactEmail = rawContactEmail.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) || contactEmail.length > 254) {
      throw new Error("enter a valid contact email")
    }
    const task = (async () => {
      const listing = store.requireActionableListing(listingId)
      const identity = store.getIdentity(listing.identityId)!
      const approvedSnapshot = snapshot(listing, identity)
      const adapter = adapterFor(listing.brokerId)
      const { result, evidence } = await withSession(
        `optout-${adapter.id}`,
        (page) => adapter.prepareOptOut(page, listing, identity, contactEmail),
        { proxySessionId: createProxySessionId(`optout-${adapter.id}`) },
      )
      const current = store.requireActionableListing(listingId)
      if (snapshot(current, store.getIdentity(current.identityId)!) !== approvedSnapshot) {
        throw new Error("profile changed while preparing; prepare a fresh preview")
      }
      const previewPath = evidence.screenshot("optout-preview", result.screenshot)
      return store.commitPreparedOptOut({
        listingId, brokerId: adapter.id, createdAt: new Date().toISOString(),
        state: {
          contactEmail, previewPath, summary: result.summary,
          snapshot: approvedSnapshot, sessionEvidenceDir: evidence.evidenceDir,
          proxySessionId: evidence.proxySessionId,
        },
      })
    })()
    preparations.set(listingId, task)
    try { return await task } finally { preparations.delete(listingId) }
  }

  function schedule(operation: "submit" | "confirm", submissionId: string, task: () => Promise<void>): void {
    const key = `${operation}:${submissionId}`
    if (jobs.has(key)) return
    const done = Promise.resolve().then(task).catch(() => {
      // The worker records actionable failures in SQLite for the queue.
    }).finally(() => jobs.delete(key))
    jobs.set(key, { submissionId, done })
  }

  async function submit(submissionId: string): Promise<void> {
    const sub = store.getSubmission(submissionId)
    if (!sub || sub.status !== "approved") return
    try {
      const { listing, identity, prepared } = preparedContext(sub)
      const adapter = adapterFor(listing.brokerId)
      await withSession(`submit-${adapter.id}`, async (page, evidence) => {
        await adapter.prepareOptOut(page, listing, identity, prepared.state.contactEmail)
        // Recheck consent/snapshot immediately before claiming the remote step.
        preparedContext(sub)
        if (!store.transitionSubmission(sub.id, "approved", "submitting", {
          incrementAttempts: true, submitSessionId: evidence.sessionId,
          lastError: null, attentionOperation: null,
        })) return
        const result = await adapter.submitOptOut(page, prepared)
        if (!result.ok) throw new Error(result.message || "broker did not confirm receipt")
        let resultPath: string | undefined
        try {
          if (result.screenshot) resultPath = evidence.screenshot("optout-result", result.screenshot)
        } catch { /* keep the confirmed receipt even if writing a screenshot fails */ }
        store.transitionSubmission(sub.id, "submitting",
          result.needsEmailConfirmation ? "awaiting_email" : "submitted", {
            resultScreenshotPath: resultPath, lastError: null, attentionOperation: null,
          }, true)
      }, { proxySessionId: prepared.state.proxySessionId })
    } catch (error) {
      const current = store.getSubmission(sub.id)
      const message = error instanceof Error ? error.message : "submission failed"
      if (current?.status === "submitting") {
        store.transitionSubmission(sub.id, "submitting", "attention_required", {
          lastError: message, attentionOperation: "submit",
        })
      } else if (current?.status === "approved") {
        store.transitionSubmission(sub.id, "approved", "failed", { lastError: message })
      }
    }
  }

  function approve(listingId: string, submissionId: string, retryAcknowledged = false): Submission {
    const sub = store.requireCurrentSubmission(listingId, submissionId)
    if (sub.status === "prepared" || sub.status === "attention_required") {
      preparedContext(sub)
      if (sub.status === "attention_required" &&
        (sub.attentionOperation !== "submit" || !retryAcknowledged)) {
        throw new Error("acknowledge that retrying may send a duplicate request")
      }
      store.transitionSubmission(sub.id, sub.status, "approved", { lastError: null, attentionOperation: null })
    } else if (sub.status !== "approved") {
      // Duplicate approval requests after the claim/success are harmless.
      if (["submitting", "submitted", "awaiting_email", "confirming", "confirmed", "removed"].includes(sub.status)) return sub
      throw new Error("prepare a new preview before approving this attempt")
    }
    schedule("submit", sub.id, () => submit(sub.id))
    return store.getSubmission(sub.id)!
  }

  function confirm(listingId: string, submissionId: string, rawUrl: string, retryAcknowledged = false): Submission {
    const sub = store.requireCurrentSubmission(listingId, submissionId)
    if (["confirming", "confirmed", "removed"].includes(sub.status)) return sub
    const listing = store.requireActionableListing(listingId)
    const adapter = adapterFor(listing.brokerId)
    if (!adapter.confirmByEmail) throw new Error("this broker has no email confirmation step")
    const url = validateBrokerConfirmationUrl(rawUrl, listing.brokerId)
    if (sub.status !== "awaiting_email" && !(sub.status === "attention_required" &&
      sub.attentionOperation === "confirm" && retryAcknowledged)) {
      throw new Error("this attempt is not waiting for email confirmation, or needs retry acknowledgement")
    }
    if (!store.transitionSubmission(sub.id, sub.status, "confirming", { lastError: null, attentionOperation: null })) {
      return store.getSubmission(sub.id)!
    }
    // The confirmation URL stays in this task's memory, never in the database.
    schedule("confirm", sub.id, async () => {
      try {
        await withSession(`confirm-${adapter.id}`, async (page, evidence) => {
          store.requireActionableListing(listingId)
          store.updateSubmission(sub.id, {
            confirmSessionId: evidence.sessionId, confirmEvidenceDir: evidence.evidenceDir,
          })
          await adapter.confirmByEmail!(page, url)
          try { evidence.screenshot("email-confirm-result", await page.screenshot({ fullPage: true })) } catch { /* receipt still persists */ }
          store.transitionSubmission(sub.id, "confirming", "confirmed", { lastError: null, attentionOperation: null })
        })
      } catch (error) {
        store.transitionSubmission(sub.id, "confirming", "attention_required", {
          lastError: error instanceof Error ? error.message : "confirmation failed",
          attentionOperation: "confirm",
        })
      }
    })
    return store.getSubmission(sub.id)!
  }

  return {
    prepare, approve, confirm,
    resume() {
      for (const sub of store.listSubmissions()) {
        if (sub.status === "approved") schedule("submit", sub.id, () => submit(sub.id))
      }
    },
    isBusy(identityId?: string) {
      const listingIds = identityId ? new Set(store.listListings(identityId).map((listing) => listing.id)) : undefined
      return [...preparations.keys()].some((id) => !listingIds || listingIds.has(id)) ||
        [...jobs.values()].some(({ submissionId }) =>
          !listingIds || listingIds.has(store.getSubmission(submissionId)?.listingId ?? ""))
    },
    async waitForIdle() {
      await Promise.all([...[...jobs.values()].map((job) => job.done), ...preparations.values()])
    },
  }
}

const globalService = globalThis as typeof globalThis & { __pjOptOutService?: ReturnType<typeof createOptOutService> }
export const optOuts = globalService.__pjOptOutService ??= createOptOutService()
