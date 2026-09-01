/**
 * Live opt-out PREPARE test (stops before submit — nothing is ever sent).
 * Verifies: form loads, URL+email fill, screenshot captured. No submit,
 * so no removal request is filed. Uses a synthetic listing for Spokeo's
 * optout form with a fake profile URL (form accepts text; we cancel before
 * any submission, so no real opt-out is triggered).
 */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const client = getSolariClient()
const browser = await client.launch({
  stealth: true,
  captcha: true,
  recording: true,
  proxy: { country: "us", session: "optout-prep", sessionDuration: 15 },
})

try {
  const page = await browser.newPage()
  console.log("loading spokeo.com/optout …")
  const resp = await page.goto("https://www.spokeo.com/optout", { waitUntil: "domcontentloaded" }).catch((e) => e)
  if (resp instanceof Error) throw resp
  console.log("status:", resp.status(), "title:", await page.title())
  await page.waitForTimeout(5000)

  // Dump the form's inputs
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input, select, textarea"))
      .slice(0, 20)
      .map((el) => ({
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        type: el.getAttribute("type"),
        placeholder: el.getAttribute("placeholder"),
      })),
  )
  for (const i of inputs) console.log("input:", JSON.stringify(i))

  // Try filling with a placeholder URL (NOT submitting)
  const urlField = page.locator('input[name="url"], input[placeholder*="www.spokeo.com" i], input[placeholder*="URL" i]').first()
  const urlVisible = await urlField.isVisible().catch(() => false)
  if (urlVisible) {
    await urlField.fill("https://www.spokeo.com/John-Smith/Washington/Seattle/p11619049415430490998118115")
    console.log("url field filled")
  } else {
    console.log("url field NOT visible — dumping page state")
    const png = await page.screenshot({ fullPage: false })
    const dir = join(process.cwd(), "data", "evidence", "optout-prep")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "spokeo-optout.png"), png)
    console.log("screenshot saved to data/evidence/optout-prep/spokeo-optout.png")
  }

  const emailField = page.locator('input[name="email"], input[type="email"]').first()
  const emailVisible = await emailField.isVisible().catch(() => false)
  if (emailVisible) {
    await emailField.fill("test@example.com")
    console.log("email field filled")
  }

  const png = await page.screenshot({ fullPage: false })
  const dir = join(process.cwd(), "data", "evidence", "optout-prep")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "filled.png"), png)
  console.log("filled-form screenshot saved — NO submit performed")
} finally {
  await browser.close()
}
process.exit(0)
