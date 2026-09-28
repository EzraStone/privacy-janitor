import { NextRequest } from "next/server"
import { ok, fail, failFromError, readJson } from "../_lib"
import * as store from "@/store"
import { resumeIncompleteScans, startScan } from "@/engine/orchestrator"
import { optOuts } from "@/engine/optouts"
import { matchHintsFor } from "@/engine/match-hints"
import { adapters } from "@/adapters/registry"
import { listEvidenceEntries, removeEvidencePaths } from "@/engine/cleanup"
import type { Identity } from "@/types"
import { normalizeAgeRange } from "@/profile"
import { assertTrustedLocalRequest } from "@/security/requests"
import { keyStatus, requireScanSetup } from "@/config/setup"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    if (keyStatus(process.env.SOLARI_API_KEY) === "configured") {
      resumeIncompleteScans()
      optOuts.resume()
    }
    const listings = store.listListings()
    return ok({
      identities: store.listIdentities(),
      listings,
      matchHints: matchHintsFor(listings, store.getIdentity),
      submissions: store.listSubmissions(),
      scans: store.listScanRuns(),
      brokers: adapters.map(({ id, name }) => ({ id, name })),
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
        | "rescan"
        | "confirm-listing"
        | "reject-listing"
        | "review-listing"
        | "delete-identity"
        | "reset-all"
      identity?: Partial<Identity>
      identityId?: string
      listingId?: string
    }>(req, ["action", "identityId", "listingId"])

    switch (body.action) {
      case "save-identity": {
        const i = body.identity
        // Trim before requiring: a lone space passes an HTML "required" check,
        // and a blank value later matches everywhere when redacting prompts.
        const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
        const fullName = text(i?.fullName)
        const city = text(i?.city)
        const stateCode = text(i?.stateCode).toUpperCase()
        if (!i || !fullName || !city || !stateCode) {
          return fail("fullName, city, and stateCode are required")
        }
        if (!/^[A-Z]{2}$/.test(stateCode)) return fail("stateCode must be a two-letter state code")
        // Each field is typed into broker search forms, one paid session per
        // broker: a name without letters or an essay-length city is a mistake.
        if (!/\p{L}/u.test(fullName) || !/\p{L}/u.test(city)) return fail("fullName and city must contain letters")
        if (fullName.length > 100 || city.length > 100) return fail("fullName and city must be at most 100 characters")
        if (i.relatives !== undefined &&
          (!Array.isArray(i.relatives) || !i.relatives.every((r) => typeof r === "string"))) {
          return fail("relatives must be a list of names")
        }
        const relatives = i.relatives?.map((r) => r.trim()).filter(Boolean)
        if (relatives && (relatives.length > 20 || relatives.some((r) => r.length > 100))) {
          return fail("list at most 20 relatives, each at most 100 characters")
        }
        const ageRange = normalizeAgeRange(text(i.ageRange))
        if (ageRange === null) return fail("ageRange must be a range such as 40-45, from 18 to 119")
        // An id means an edit. The profile must still exist — a stale form in
        // another tab must not recreate one that was deleted — and its stored
        // creation time stands, whatever the form sends.
        if (i.id !== undefined && typeof i.id !== "string") return fail("identity id must be a string")
        const existing = i.id === undefined ? undefined : store.getIdentity(i.id)
        if (i.id !== undefined && !existing) return fail("profile not found", 404)
        const identity: Identity = {
          id: existing?.id ?? store.newId("id"),
          fullName,
          city,
          stateCode,
          ageRange,
          relatives: relatives?.length ? relatives : undefined,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        }
        store.saveIdentity(identity)
        return ok({ identity })
      }

      case "scan":
      case "rescan": {
        if (!body.identityId) return fail("identityId required")
        if (!store.getIdentity(body.identityId)) return fail("identity not found", 404)
        requireScanSetup()
        const { run, resumed, conflict } = startScan(
          body.identityId,
          body.action === "rescan" ? "rescan" : "scan",
        )
        if (conflict) {
          return fail(`a ${run.kind} is already running for this profile`, 409)
        }
        return ok({ started: true, resumed, identityId: body.identityId, runId: run.id })
      }

      case "confirm-listing":
      case "reject-listing": {
        if (!body.listingId) return fail("listingId required")
        if (!store.setListingConfirmed(body.listingId, body.action === "confirm-listing")) {
          return fail("listing not found", 404)
        }
        return ok({ done: true })
      }

      case "review-listing": {
        if (!body.listingId) return fail("listingId required")
        if (store.activeSubmission(body.listingId)) {
          return fail("cancel or finish this listing's active request before reviewing it again", 409)
        }
        if (!store.returnListingToReview(body.listingId)) return fail("listing not found", 404)
        return ok({ done: true })
      }

      case "delete-identity": {
        if (!body.identityId) return fail("identityId required")
        if (store.listScanRuns(body.identityId).some((run) => !run.finishedAt) || optOuts.isBusy(body.identityId)) {
          return fail("wait for active scans and broker actions to finish before deleting this profile", 409)
        }
        // DB rows go in one transaction; evidence files after commit.
        const evidenceDirs = store.deleteIdentity(body.identityId)
        const filesRemoved = removeEvidencePaths(evidenceDirs)
        return ok({ done: true, evidenceCleaned: filesRemoved })
      }

      case "reset-all": {
        if (store.listScanRuns().some((run) => !run.finishedAt) || optOuts.isBusy()) {
          return fail("wait for active scans and broker actions to finish before resetting local data", 409)
        }
        const { evidenceDirs } = store.resetAll()
        const filesRemoved = removeEvidencePaths([...evidenceDirs, ...listEvidenceEntries()])
        return ok({ done: true, evidenceCleaned: filesRemoved })
      }

      default:
        return fail("unknown action")
    }
  } catch (err) {
    return failFromError(err)
  }
}
