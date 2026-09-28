/**
 * Shared JSON responses and bounded request parsing for the local API.
 */
import { NextResponse } from "next/server"
import { StatusError } from "@/errors"
import { RequestValidationError } from "@/security/requests"

export const dynamic = "force-dynamic"

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 })
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export function failFromError(error: unknown) {
  if (error instanceof StatusError) return fail(error.message, error.status)
  return fail(error instanceof Error ? error.message : "request failed", 500)
}

/**
 * Parse a JSON object body whose named fields, when present, are strings.
 * The routes pass ids and text straight to SQLite and string methods, where
 * an object or number would fail as a 500 instead of a client error.
 */
export async function readJson<T>(req: Request, stringFields: string[] = [], maxBytes = 16_384): Promise<T> {
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
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RequestValidationError("invalid JSON body")
  }
  // Every route reads named fields, so anything but a plain object is a
  // client error — `null` would otherwise crash the handler with a 500.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RequestValidationError("JSON body must be an object")
  }
  for (const field of stringFields) {
    const value = (parsed as Record<string, unknown>)[field]
    if (value !== undefined && typeof value !== "string") {
      throw new RequestValidationError(`${field} must be a string`)
    }
  }
  return parsed as T
}
