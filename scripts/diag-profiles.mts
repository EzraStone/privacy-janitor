/**
 * Diagnose the REAL profile-URL shapes on each broker's results pages.
 * Drives each search flow, then dumps anchor hrefs so the adapters' URL
 * filters can be written against facts, not guesses.
 */
import "dotenv/config"
import { getSolariClient } from "../src/engine/solari.ts"

const client = getSolariClient()

async function newSession() {
  return client.launch({
    stealth: true,
    captcha: true,
    recording: false,
    proxy: { country: "us", session: `diag-${Date.now().toString(36)}`, sessionDuration: 15 },
  })
}

async function dumpHrefs(page: any, label: string) {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => !!h && h.length > 1),
  )
  const seen = new Set<string>()
  console.log(`--- ${label} hrefs (${hrefs.length}) ---`)
  for (const h of hrefs) {
    const path = h.split("?")[0]
    if (seen.has(path)) continue
    seen.add(path)
    if (seen.size > 60) break
    console.log("  ", h)
  }
}

// ── 1. Whitepages: homepage search flow ────────────────────────────────────
{
  const browser = await newSession()
  try {
    const page = await browser.newPage()
    await page.goto("https://www.whitepages.com", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(4000)
    await page.locator("#search-name").fill("John Smith")
    await page.locator("#search-location").fill("Seattle, WA")
    await page.locator("#search-location").press("Enter")
    await page.waitForTimeout(7000)
    console.log("\n===== WHITEPAGES =====")
    console.log("url:", page.url())
    console.log("title:", await page.title())
    await dumpHrefs(page, "results")
  } finally {
    await browser.close()
  }
}

// ── 2. Spokeo: state page -> metro page drill ──────────────────────────────
{
  const browser = await newSession()
  try {
    const page = await browser.newPage()
    await page.goto("https://www.spokeo.com/John-Smith/Washington", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(5000)
    console.log("\n===== SPOKEO (state page) =====")
    console.log("url:", page.url())
    console.log("title:", await page.title())
    const metro = page.locator('a[href*="Seattle"]').first()
    if (await metro.isVisible().catch(() => false)) {
      await metro.click()
      await page.waitForTimeout(5000)
      console.log("\n===== SPOKEO (metro page) =====")
      console.log("url:", page.url())
      console.log("title:", await page.title())
      await dumpHrefs(page, "metro")
    } else {
      console.log("no Seattle metro link — dumping state page instead")
      await dumpHrefs(page, "state")
    }
  } finally {
    await browser.close()
  }
}

// ── 3. FastPeopleSearch: homepage search flow ──────────────────────────────
{
  const browser = await newSession()
  try {
    const page = await browser.newPage()
    await page.goto("https://www.fastpeoplesearch.com", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(4000)
    await page.locator("#search-name-name").fill("John Smith")
    await page.locator("#search-name-address").fill("Seattle, WA")
    await page.locator("#search-name-address").press("Enter")
    await page.waitForTimeout(7000)
    console.log("\n===== FASTPEOPLESEARCH =====")
    console.log("url:", page.url())
    console.log("title:", await page.title())
    await dumpHrefs(page, "results")
  } finally {
    await browser.close()
  }
}

process.exit(0)
