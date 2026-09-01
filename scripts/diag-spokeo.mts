/** Spokeo results-page diagnosis: what appears after submitting the hero form? */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const client = getSolariClient()
const browser = await client.launch({
  stealth: true,
  captcha: true,
  recording: true,
  proxy: { country: "us", session: "spokeo-diag", sessionDuration: 10 },
})

try {
  const page = await browser.newPage()
  await page.goto("https://www.spokeo.com", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(4000)

  const q = page.locator('#homepage_hero_form input[name="q"]').first()
  await q.fill("John Smith")
  await q.press("Enter")
  await page.waitForTimeout(6000)

  console.log("after search url:", page.url())
  console.log("title:", await page.title())

  // Any captcha?
  const turnstile = await page
    .locator('iframe[src*="turnstile"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')
    .count()
  console.log("captcha frames:", turnstile)

  // Dump hrefs
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.getAttribute("href"))
      .filter(Boolean)
      .filter((h) => h!.length > 1)
      .slice(0, 50),
  )
  console.log("hrefs:")
  for (const h of hrefs) console.log("  ", h)

  const png = await page.screenshot({ fullPage: false })
  const dir = join(process.cwd(), "data", "evidence", "spokeo-diag")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "results.png"), png)
  console.log("screenshot saved")
} finally {
  await browser.close()
}
process.exit(0)
