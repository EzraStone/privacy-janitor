/** Probe what the current Solari plan allows — no stealth features. */
import "dotenv/config"
import { Solari } from "@solarisdk/browser"

const client = new Solari({
  apiKey: process.env.SOLARI_API_KEY!,
  baseUrl: "https://api.getsolari.com",
})

console.log("launching DEFAULT (non-stealth) session…")
const browser = await client.launch()
try {
  const page = await browser.newPage()
  await page.goto("https://example.com", { waitUntil: "domcontentloaded" })
  console.log("default session works. title:", await page.title())

  // Can we reach whitepages at all without stealth?
  const resp = await page
    .goto("https://www.whitepages.com", { waitUntil: "domcontentloaded" })
    .catch((e) => e)
  if (resp instanceof Error) throw resp
  console.log("whitepages status:", resp.status())
  await page.waitForTimeout(3000)
  console.log("whitepages title:", await page.title())
} finally {
  await browser.close()
}
console.log("done")
process.exit(0)
