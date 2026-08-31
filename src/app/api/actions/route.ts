import { NextRequest } from "next/server"
import { ok, fail, readJson } from "../_lib"
import {
  prepareListingOptOut,
  submitApprovedOptOut,
  confirmOptOutEmail,
} from "@/engine/orchestrator"
import { scoreExposure } from "@/scoring"
import * as store from "@/store"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<{
      action:
        | "prepare-optout"
        | "approve-optout"
        | "cancel-optout"
        | "confirm-email"
        | "score"
      listingId?: string
      identityId?: string
      contactEmail?: string
      confirmationUrl?: string
    }>(req)

    switch (body.action) {
      case "prepare-optout": {
        if (!body.listingId || !body.contactEmail)
          return fail("listingId and contactEmail are required")
        const res = await prepareListingOptOut(body.listingId, body.contactEmail)
        return ok(res)
      }

      case "approve-optout": {
        if (!body.listingId) return fail("listingId required")
        await submitApprovedOptOut(body.listingId)
        return ok({ done: true })
      }

      case "cancel-optout": {
        if (!body.listingId) return fail("listingId required")
        store.deletePreparedOptOut(body.listingId)
        return ok({ done: true })
      }

      case "confirm-email": {
        if (!body.listingId || !body.confirmationUrl)
          return fail("listingId and confirmationUrl are required")
        await confirmOptOutEmail(body.listingId, body.confirmationUrl)
        return ok({ done: true })
      }

      case "score": {
        if (!body.identityId) return fail("identityId required")
        const identity = store.getIdentity(body.identityId)
        if (!identity) return fail("identity not found", 404)
        const confirmed = store
          .listListings(body.identityId)
          .filter((l) => l.confirmedMine === true)
        if (confirmed.length === 0) return fail("no confirmed listings to score yet")
        const report = await scoreExposure(identity, confirmed)
        return ok({ report })
      }

      default:
        return fail("unknown action")
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : "request failed", 500)
  }
}
