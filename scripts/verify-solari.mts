/**
 * Live Solari verification — no PII needed.
 *
 * Proves the whole session recipe end-to-end against the site that matters:
 * whitepages.com, which 403s plain HTTP clients. If we can load it in a
 * stealth session, screenshot it, and pull a replay URL, the platform bet
 * of this entire project is validated.
 *
 * Run: node --experimental-strip-types scripts/verify-solari.mts
 */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

async function main() {
  if (!process.env.SOLARI_API_KEY?.startsWith("slr_live_")) {
    throw new Error("SOLARI_API_KEY missing/malformed in .env")
  }

  console.log("launching stealth session (captcha+recording+sticky us proxy)…")
  const client = getSolariClient()
  const browser = await client.launch({
    stealth: true,
    captcha: true,
    recording: true,
    proxy: { country: "us", session: "verify-1", sessionDuration: 10 },
  })
  console.log("session id:", browser.id)

  try {
    const page = await browser.newPage()

    // 1. Baseline sanity: a page that never blocks.
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" })
    console.log("example.com title:", await page.title())

    // 2. The real test: Whitepages (403s non-browser clients).
    const resp = await page.goto("https://www.whitepages.com", { waitUntil: "domcontentloaded" }).catch((e) => e)
    if (resp instanceof Error) throw resp
    console.log("whitepages status:", resp.status())
    await page.waitForTimeout(3000)
    console.log("whitepages title:", await page.title())

    // 3. Evidence: screenshot of the loaded homepage.
    const png = await page.screenshot({ fullPage: false })
    const outDir = join(process.cwd(), "data", "evidence", "verify-solari")
    mkdirSync(outDir, { recursive: true })
    const outPath = join(outDir, "whitepages-home.png")
    writeFileSync(outPath, png)
    console.log("screenshot saved:", outPath)

    // 4. Check the search box is reachable (first selector layer of our adapter).
    const searchBox = page.locator('input[name="search_term"], input[placeholder*="Name" i], input[type="text"]').first()
    const visible = await searchBox.isVisible().catch(() => false)
    console.log("whitepages search box visible:", visible)
  } finally {
    await browser.close()
    console.log("session closed cleanly")
  }

  // 5. Replay URL (upload is async — poll).
  const sessionId = browser.id
  console.log("polling for replay url…")
  let replay: string | undefined
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !replay) {
    try {
      const { url } = await client.sessions.getReplayUrl(sessionId)
      if (url) replay = url
    } catch {
      /* not ready yet */
    }
    if (!replay) await new Promise((r) => setTimeout(r, 2500))
  }
  console.log(replay ? `replay: ${replay}` : "replay: not available within 30s (check console)")
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e)
  process.exit(1)
})
