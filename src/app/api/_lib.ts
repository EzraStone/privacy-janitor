/**
 * Next.js server config for API routes. Loads .env at dev-time too (Next
 * only auto-loads it for `next dev`; scripts use dotenv themselves).
 */
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export function ok<T>(data: T, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 })
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new Error("invalid JSON body")
  }
}
