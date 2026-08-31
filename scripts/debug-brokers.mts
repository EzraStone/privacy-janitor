/** Debug broker search pages: dump screenshots, inputs, and link shapes. */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const outDir = join(process.cwd(), "data", "evidence", "broker-debug")
mkdirSync(outDir, { recursive: true })

const client = getSolariClient()

async function dump(label: string, url: string) {
  const browser = await client.launch().catch((e) => {
    console.error(`${label}: launch failed`, e.message)
    throw e
  })
  try {
    const page = await browser.newPage()
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => e)
    if (resp instanceof Error) throw resp
    console.log(`\n===== ${label} =====`)
    console.log("status:", resp.status(), "title:", await page.title())
    await page.waitForTimeout(4000)

    // save screenshot
    const png = await page.screenshot({ fullPage: false })
    writeFileSync(join(outDir, `${label}.png`), png)

    // dump all input fields
    const inputs = await page
      .locator("input, select, textarea, button[type=submit]")
      .all()
    for (const inp of inputs.slice(0, 25)) {
      const attrs = {
        tag: "input",
        name: await inp.getAttribute("name").catch(() => null),
        id: await inp.getAttribute("id").catch(() => null),
        type: await inp.getAttribute("type").catch(() => null),
        placeholder: await inp.getAttribute("placeholder").catch(() => null),
      }
      console.log("input:", JSON.stringify(attrs))
    }

    // dump first 20 link hrefs matching people-profile-ish patterns
    const hrefs = await page.locator("a").evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href")).filter(Boolean).slice(0, 40),
    )
    console.log("hrefs sample:")
    for (const h of hrefs) console.log("  ", h)
  } finally {
    await browser.close()
  }
}

await dump("spokeo-search", "https://www.spokeo.com/John%20Smith?country=USA&state=WA&city=Seattle")
await dump("fps-search", "https://www.fastpeoplesearch.com/name/john-smith-seattle-wa")
process.exit(0)
