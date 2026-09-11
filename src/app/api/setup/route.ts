import { NextRequest } from "next/server"
import { ok, failFromError } from "../_lib"
import { getSetupStatus } from "@/config/setup"
import { assertTrustedLocalRequest } from "@/security/requests"

export const dynamic = "force-dynamic"

/** Local diagnostics only: no provider calls, browser sessions, or key values. */
export async function GET(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    const response = ok(getSetupStatus())
    response.headers.set("Cache-Control", "no-store")
    return response
  } catch (error) {
    return failFromError(error)
  }
}
