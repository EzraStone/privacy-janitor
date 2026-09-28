/**
 * Reading a finished exposure report against the listings as they are now.
 * No provider SDK here: the dashboard imports this in the browser.
 */
import type { Listing } from "@/types"
import type { ExposureReport, ListingRisk } from "./index.ts"

/**
 * The rankings still about a present, confirmed listing, how many are not,
 * and how many current listings the model left unranked. A report outlives
 * decisions made after it: a listing marked not you, found gone by a rescan,
 * or deleted keeps its old ranking until the next report, and must not be
 * shown as current.
 */
export function currentRankings(
  report: ExposureReport,
  listings: Listing[],
): { rankings: ListingRisk[]; stale: number; unranked: number } {
  const current = new Set(listings
    .filter((listing) => listing.confirmedMine === true && listing.presenceStatus !== "absent")
    .map((listing) => listing.id))
  const rankings = report.rankings.filter((ranking) => current.has(ranking.listingId))
  return {
    rankings,
    stale: report.rankings.length - rankings.length,
    unranked: (report.unrankedListingIds ?? []).filter((id) => current.has(id)).length,
  }
}
