import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { getEvidenceDir } from "@/config/paths"
import { assertTrustedLocalRequest } from "@/security/requests"
import { failFromError } from "../_lib"

export const dynamic = "force-dynamic"

/** Serve evidence files (screenshots) from data/evidence — local only. */
export async function GET(req: NextRequest) {
  try {
    assertTrustedLocalRequest(req)
    const url = new URL(req.url).searchParams
    const file = url.get("file")
    if (!file) return NextResponse.json({ error: "file param required" }, { status: 400 })

    // Normalize and jail the path under the evidence directory.
    const base = getEvidenceDir()
    const target = isAbsolute(file) ? resolve(file) : resolve(base, file)
    const child = relative(base, target)
    if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 })
    }

    const buf = await readFile(target)
    const ext = target.endsWith(".png") ? "image/png" : "application/octet-stream"
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": ext,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    })
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 })
    }
    return failFromError(err)
  }
}
