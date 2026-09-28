import { NextRequest } from "next/server"
import { ok, failFromError } from "../_lib"
import { getSetupStatus } from "@/config/setup"
import { assertTrustedLocalRequest } from "@/security/requests"

export const dynamic = "force-dynamic"

/** Local diagnostics only: no provider calls, browser sessions, or key values. */
export async function GET(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    return ok(getSetupStatus())
  } catch (error) {
    return failFromError(error)
  }
}
