import type { Identity, Listing, MatchExplanation } from "../types.ts"
import { adapters } from "../adapters/registry.ts"

/**
 * Hints for the listings awaiting "Is this you?" review, keyed by listing id.
 * A decided or absent listing gets none: there is no decision left to inform.
 */
export function matchHintsFor(
  listings: Listing[],
  identityFor: (id: string) => Identity | undefined,
): Record<string, MatchExplanation> {
  const hints: Record<string, MatchExplanation> = {}
  for (const listing of listings) {
    if (listing.confirmedMine !== null || listing.presenceStatus === "absent") continue
    const identity = identityFor(listing.identityId)
    const adapter = adapters.find((candidate) => candidate.id === listing.brokerId)
    if (identity && adapter) hints[listing.id] = adapter.explainMatch(listing, identity)
  }
  return hints
}
