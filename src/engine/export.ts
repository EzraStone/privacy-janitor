/**
 * A profile's records as one JSON document the person can keep: what was
 * found where, what they decided, every removal request and every scan.
 *
 * Local file paths and preview state stay out: they describe this machine,
 * not the person's records, and screenshots are not embedded.
 */
import type { BrokerAdapter, Listing } from "../types.ts"
import * as store from "../store/index.ts"
import { NotFoundError } from "../errors.ts"

export const EXPORT_FORMAT = "privacy-janitor-records/1"

export function exportProfileRecords(identityId: string, brokers: BrokerAdapter[]) {
  const identity = store.getIdentity(identityId)
  if (!identity) throw new NotFoundError("profile not found")
  const brokerName = (id: string) => brokers.find((broker) => broker.id === id)?.name ?? id
  const listings = store.listListings(identityId)
  const byId = new Map(listings.map((listing) => [listing.id, listing]))
  const decision = (listing: Listing) =>
    listing.confirmedMine === true ? "yours" : listing.confirmedMine === false ? "not_you" : "undecided"

  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    profile: {
      fullName: identity.fullName,
      city: identity.city,
      stateCode: identity.stateCode,
      ageRange: identity.ageRange,
      relatives: identity.relatives,
      createdAt: identity.createdAt,
    },
    listings: listings.map((listing) => ({
      id: listing.id,
      broker: brokerName(listing.brokerId),
      url: listing.url,
      displayName: listing.displayName,
      decision: decision(listing),
      presence: listing.presenceStatus ?? "seen",
      firstSeenAt: listing.firstSeenAt,
      lastSeenAt: listing.lastSeenAt,
      lastAbsentAt: listing.lastAbsentAt,
      exposedData: listing.exposedData,
    })),
    requests: listings.flatMap((listing) => store.listSubmissions(listing.id)).map((request) => ({
      listingId: request.listingId,
      broker: brokerName(byId.get(request.listingId)?.brokerId ?? ""),
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      attempts: request.attempts,
      removedVerifiedAt: request.removedVerifiedAt,
      lastError: request.lastError,
      submitSessionId: request.submitSessionId,
      confirmSessionId: request.confirmSessionId,
    })),
    scans: store.listScanRuns(identityId).map((run) => ({
      kind: run.kind,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      results: run.results.map((result) => ({
        broker: brokerName(result.brokerId),
        outcome: result.outcome,
        listingsFound: result.listingsFound,
        issue: result.error,
      })),
      changes: run.events.map((event) => ({ listingId: event.listingId, change: event.type, at: event.recordedAt })),
    })),
  }
}
