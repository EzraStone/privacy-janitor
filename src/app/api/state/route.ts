import { NextRequest } from "next/server"
import { ok, fail, failFromError, readJson } from "../_lib"
import * as store from "@/store"
import { resumeIncompleteScans, startScan } from "@/engine/orchestrator"
import { removeEvidencePaths } from "@/engine/cleanup"
import type { Identity } from "@/types"
import { assertTrustedLocalRequest } from "@/security/requests"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    resumeIncompleteScans()
    return ok({
      identities: store.listIdentities(),
      listings: store.listListings(),
      submissions: store.listSubmissions(),
      scans: store.listScanRuns(),
    })
  } catch (err) {
    return failFromError(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    const body = await readJson<{
      action:
        | "save-identity"
        | "scan"
        | "confirm-listing"
        | "reject-listing"
        | "delete-identity"
        | "reset-all"
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
          id: i.id ?? `id_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
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
        if (!store.getIdentity(body.identityId)) return fail("identity not found", 404)
        const { run, resumed } = startScan(body.identityId)
        return ok({ started: true, resumed, identityId: body.identityId, runId: run.id })
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

      case "delete-identity": {
        if (!body.identityId) return fail("identityId required")
        if (store.listScanRuns(body.identityId).some((run) => !run.finishedAt)) {
          return fail("wait for the active scan to finish before deleting this profile", 409)
        }
        // DB rows go in one transaction; evidence files after commit.
        const evidenceDirs = store.deleteIdentity(body.identityId)
        const filesRemoved = removeEvidencePaths(evidenceDirs)
        return ok({ done: true, evidenceCleaned: filesRemoved })
      }

      case "reset-all": {
        if (store.listScanRuns().some((run) => !run.finishedAt)) {
          return fail("wait for active scans to finish before resetting local data", 409)
        }
        const { evidenceDirs } = store.resetAll()
        const filesRemoved = removeEvidencePaths(evidenceDirs)
        return ok({ done: true, evidenceCleaned: filesRemoved })
      }

      default:
        return fail("unknown action")
    }
  } catch (err) {
    return failFromError(err)
  }
}
