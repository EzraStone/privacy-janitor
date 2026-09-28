import { NextRequest, NextResponse } from "next/server"
import { fail, failFromError } from "../_lib"
import { adapters } from "@/adapters/registry"
import { exportProfileRecords } from "@/engine/export"
import { assertTrustedLocalRequest } from "@/security/requests"

export const dynamic = "force-dynamic"

/** Download one profile's records as JSON — local only, no screenshots. */
export async function GET(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    const identityId = new URL(req.url).searchParams.get("identityId")
    if (!identityId) return fail("identityId required")
    const records = exportProfileRecords(identityId, adapters)
    const slug = records.profile.fullName.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile"
    return new NextResponse(JSON.stringify(records, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="privacy-janitor-${slug}-${records.exportedAt.slice(0, 10)}.json"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    })
  } catch (err) {
    return failFromError(err)
  }
}
