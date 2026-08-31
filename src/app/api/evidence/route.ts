import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

export const dynamic = "force-dynamic"

/** Serve evidence files (screenshots) from data/evidence — local only. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url).searchParams
  const file = url.get("file")
  if (!file) return NextResponse.json({ error: "file param required" }, { status: 400 })

  // Normalize and jail the path under data/ — never allow traversal.
  const base = resolve(process.cwd(), "data")
  const target = resolve(base, file)
  if (!target.startsWith(base)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 })
  }

  try {
    const buf = await readFile(target)
    const ext = target.endsWith(".png") ? "image/png" : "application/octet-stream"
    return new NextResponse(new Uint8Array(buf), {
      headers: { "content-type": ext, "cache-control": "no-store" },
    })
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
}
