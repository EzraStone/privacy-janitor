/**
 * Next.js server config for API routes. Loads .env at dev-time too (Next
 * only auto-loads it for `next dev`; scripts use dotenv themselves).
 */
import { NextResponse } from "next/server"
import { RequestValidationError } from "@/security/requests"

export const dynamic = "force-dynamic"

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 })
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export function failFromError(error: unknown) {
  if (error instanceof RequestValidationError) return fail(error.message, error.status)
  return fail(error instanceof Error ? error.message : "request failed", 500)
}

export async function readJson<T>(req: Request, maxBytes = 16_384): Promise<T> {
  const contentType = req.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RequestValidationError("content-type must be application/json", 415)
  }

  const declaredBytes = Number(req.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw new RequestValidationError("request body too large", 413)
  }

  const raw = await req.text()
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new RequestValidationError("request body too large", 413)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new RequestValidationError("invalid JSON body")
  }
}
