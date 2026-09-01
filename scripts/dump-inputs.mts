/** Stealth-mode DOM dump: find the real search-box selectors on broker homepages. */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"

const client = getSolariClient()

async function dumpInputs(url: string, label: string) {
  const browser = await client.launch({
    stealth: true,
    captcha: true,
    recording: false,
    proxy: { country: "us", session: `dump-${Date.now().toString(36)}`, sessionDuration: 10 },
  })
  try {
    const page = await browser.newPage()
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => e)
    if (resp instanceof Error) throw resp
    console.log(`\n===== ${label} =====`)
    console.log("status:", resp.status(), "title:", await page.title())
    await page.waitForTimeout(5000)

    const inputs = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("input, select"))
      return els.slice(0, 30).map((el) => ({
        tag: el.tagName.toLowerCase(),
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        type: el.getAttribute("type"),
        placeholder: el.getAttribute("placeholder"),
        ariaLabel: el.getAttribute("aria-label"),
      }))
    })
    for (const i of inputs) console.log("input:", JSON.stringify(i))

    // forms
    const forms = await page.evaluate(() =>
      Array.from(document.querySelectorAll("form"))
        .slice(0, 10)
        .map((f) => ({
          action: f.getAttribute("action"),
          id: f.getAttribute("id"),
          class: f.getAttribute("class"),
        })),
    )
    for (const f of forms) console.log("form:", JSON.stringify(f))
  } finally {
    await browser.close()
  }
}

await dumpInputs("https://www.spokeo.com", "spokeo-home")
await dumpInputs("https://www.fastpeoplesearch.com", "fps-home")
process.exit(0)
