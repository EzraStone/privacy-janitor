import { NextRequest } from "next/server"
import { ok, fail, readJson } from "../_lib"
import * as store from "@/store"
import { runScan } from "@/engine/orchestrator"
import type { Identity } from "@/types"

export const dynamic = "force-dynamic"

export async function GET() {
  return ok({
    identities: store.listIdentities(),
    listings: store.listListings(),
    submissions: store.listSubmissions(),
    scans: store.listScanRuns(),
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<{
      action: "save-identity" | "scan" | "confirm-listing" | "reject-listing"
      identity?: Partial<Identity>
      identityId?: string
      listingId?: string
    }>(req)

    switch (body.action) {
      case "save-identity": {
        const i = body.identity
        if (!i?.fullName || !i?.city || !i?.stateCode) {
          return fail("fullName, city, and stateCode are required")
        }
        const identity: Identity = {
          id: i.id ?? `id_${Date.now().toString(36)}`,
          fullName: i.fullName.trim(),
          city: i.city.trim(),
          stateCode: i.stateCode.trim().toUpperCase(),
          ageRange: i.ageRange?.trim() || undefined,
          relatives: i.relatives,
          createdAt: i.createdAt ?? new Date().toISOString(),
        }
        store.saveIdentity(identity)
        return ok({ identity })
      }

      case "scan": {
        if (!body.identityId) return fail("identityId required")
        // Long-running; fire-and-forget with run id surfaced via scans list.
        const identity = store.getIdentity(body.identityId)
        if (!identity) return fail("identity not found", 404)
        void runScan(body.identityId).catch(() => {})
        return ok({ started: true, identityId: body.identityId })
      }

      case "confirm-listing": {
        if (!body.listingId) return fail("listingId required")
        store.setListingConfirmed(body.listingId, true)
        return ok({ done: true })
      }

      case "reject-listing": {
        if (!body.listingId) return fail("listingId required")
        store.setListingConfirmed(body.listingId, false)
        return ok({ done: true })
      }

      default:
        return fail("unknown action")
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : "request failed", 500)
  }
}
