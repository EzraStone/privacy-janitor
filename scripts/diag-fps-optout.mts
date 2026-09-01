/** Dump FastPeopleSearch removal-form structure (no submit). */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"

const client = getSolariClient()
const browser = await client.launch({
  stealth: true,
  captcha: true,
  recording: false,
  proxy: { country: "us", session: "fps-optout-diag", sessionDuration: 15 },
})

try {
  const page = await browser.newPage()
  console.log("loading fastpeoplesearch.com/removal …")
  const resp = await page
    .goto("https://www.fastpeoplesearch.com/removal", { waitUntil: "domcontentloaded" })
    .catch((e) => e)
  if (resp instanceof Error) throw resp
  console.log("status:", resp.status(), "title:", await page.title())
  await page.waitForTimeout(5000)

  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input, select, textarea, button, a.btn"))
      .slice(0, 25)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        type: el.getAttribute("type"),
        placeholder: el.getAttribute("placeholder"),
        text: el.textContent?.trim().slice(0, 60),
      })),
  )
  for (const f of fields) console.log("field:", JSON.stringify(f))
} finally {
  await browser.close()
}
process.exit(0)
