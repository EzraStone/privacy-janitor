/** Dump Whitepages suppression-request form inputs (no submit). */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"

const client = getSolariClient()
const browser = await client.launch({
  stealth: true,
  captcha: true,
  recording: false,
  proxy: { country: "us", session: "wp-optout-diag", sessionDuration: 15 },
})

try {
  const page = await browser.newPage()
  console.log("loading whitepages.com/suppression_requests …")
  const resp = await page
    .goto("https://www.whitepages.com/suppression_requests", { waitUntil: "domcontentloaded" })
    .catch((e) => e)
  if (resp instanceof Error) throw resp
  console.log("status:", resp.status(), "title:", await page.title())
  await page.waitForTimeout(5000)

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input, select, textarea, button"))
      .slice(0, 25)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        type: el.getAttribute("type"),
        placeholder: el.getAttribute("placeholder"),
        text: el.tagName === "BUTTON" ? el.textContent?.trim().slice(0, 40) : null,
      })),
  )
  for (const i of inputs) console.log("field:", JSON.stringify(i))

  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => !!h && h.length > 1)
      .slice(0, 25),
  )
  console.log("hrefs:")
  for (const h of hrefs) console.log("  ", h)
} finally {
  await browser.close()
}
process.exit(0)
