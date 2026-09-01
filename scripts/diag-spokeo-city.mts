/** Drill Spokeo: state -> metro -> city -> find person-profile URL shape. */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"

const client = getSolariClient()
const browser = await client.launch({
  stealth: true,
  captcha: true,
  recording: false,
  proxy: { country: "us", session: "spokeo-city", sessionDuration: 15 },
})

try {
  const page = await browser.newPage()
  await page.goto("https://www.spokeo.com/John-Smith/Washington/Seattle--Tacoma--Bremerton-Metro", {
    waitUntil: "domcontentloaded",
  })
  await page.waitForTimeout(4000)

  const seattle = page.locator('a[href$="/Seattle"]').first()
  if (await seattle.isVisible().catch(() => false)) {
    await seattle.click()
    await page.waitForTimeout(5000)
  } else {
    console.log("no /Seattle link; trying direct goto")
    await page.goto("https://www.spokeo.com/John-Smith/Washington/Seattle", {
      waitUntil: "domcontentloaded",
    })
    await page.waitForTimeout(5000)
  }

  console.log("url:", page.url())
  console.log("title:", await page.title())

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => !!h && h.length > 1),
  )
  const seen = new Set<string>()
  console.log(`--- city-page hrefs (${hrefs.length}) ---`)
  for (const h of hrefs) {
    const path = h.split("?")[0]
    if (seen.has(path)) continue
    seen.add(path)
    if (seen.size > 50) break
    console.log("  ", h)
  }
} finally {
  await browser.close()
}
process.exit(0)
