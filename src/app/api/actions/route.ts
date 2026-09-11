import { NextRequest } from "next/server"
import { ok, fail, failFromError, readJson } from "../_lib"
import { optOuts } from "@/engine/optouts"
import { scoreExposure } from "@/scoring"
import * as store from "@/store"
import { requireScanSetup } from "@/config/setup"
import {
  assertTrustedLocalRequest,
  validateBrokerConfirmationUrl,
} from "@/security/requests"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    const body = await readJson<{
      action:
        | "prepare-optout"
        | "approve-optout"
        | "cancel-optout"
        | "confirm-email"
        | "score"
      listingId?: string
      submissionId?: string
      retryAcknowledged?: boolean
      identityId?: string
      contactEmail?: string
      confirmationUrl?: string
    }>(req)

    switch (body.action) {
      case "prepare-optout": {
        if (!body.listingId || !body.contactEmail)
          return fail("listingId and contactEmail are required")
        requireScanSetup()
        const submission = await optOuts.prepare(body.listingId, body.contactEmail)
        return ok({ submission })
      }

      case "approve-optout": {
        if (!body.listingId || !body.submissionId) return fail("listingId and submissionId required")
        requireScanSetup()
        const submission = optOuts.approve(body.listingId, body.submissionId, body.retryAcknowledged === true)
        return ok({ submission }, 202)
      }

      case "cancel-optout": {
        if (!body.listingId || !body.submissionId) return fail("listingId and submissionId required")
        return ok({ submission: store.cancelSubmission(body.listingId, body.submissionId) })
      }

      case "confirm-email": {
        if (!body.listingId || !body.submissionId || !body.confirmationUrl)
          return fail("listingId, submissionId, and confirmationUrl are required")
        requireScanSetup()
        const listing = store.getListing(body.listingId)
        if (!listing) return fail("listing not found", 404)
        const confirmationUrl = validateBrokerConfirmationUrl(
          body.confirmationUrl,
          listing.brokerId,
        )
        const submission = optOuts.confirm(body.listingId, body.submissionId, confirmationUrl, body.retryAcknowledged === true)
        return ok({ submission }, 202)
      }

      case "score": {
        if (!body.identityId) return fail("identityId required")
        const identity = store.getIdentity(body.identityId)
        if (!identity) return fail("identity not found", 404)
        const confirmed = store
          .listListings(body.identityId)
          .filter((l) => l.confirmedMine === true && l.presenceStatus !== "absent")
        if (confirmed.length === 0) return fail("no confirmed listings to score yet")
        const report = await scoreExposure(identity, confirmed)
        return ok({ report })
      }

      default:
        return fail("unknown action")
    }
  } catch (err) {
    return failFromError(err)
  }
}
