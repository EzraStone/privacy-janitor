/**
 * Spokeo adapter.
 *
 * Scan:  spokeo.com search by name + city/state -> profile cards.
 * Opt-out: spokeo.com/optout -> paste profile URL (or re-find by search) ->
 *        email + captcha -> submit -> confirmation email link -> final click.
 *
 * Spokeo's opt-out is one of the friendlier ones: it takes a profile URL
 * directly, which makes our per-listing flow simple — no record matching.
 */
import type {
  BrokerAdapter,
  FilledOptOutForm,
  Identity,
  Listing,
  OptOutReceipt,
  PreparedOptOut,
} from "@/types"
import { newId } from "../store/index.ts"
import { firstVisible, tryAllTexts, tryClick, tryInnerText, scoreMatch, isPersonProfileSlug } from "./helpers.ts"

const OPTOUT_URL = "https://www.spokeo.com/optout"

export const spokeo: BrokerAdapter = {
  id: "spokeo",
  name: "Spokeo",
  homepage: "https://www.spokeo.com",
  optOutInfo:
    "Official opt-out form at spokeo.com/optout. Paste the profile URL, solve a captcha, " +
    "and confirm via the email link Spokeo sends. Removal within 1-2 business days.",

  expectsEmailConfirmation: true,

  // ── scan ───────────────────────────────────────────────────────────────────

  async scan(page, identity): Promise<Listing[]> {
    const listings: Listing[] = []
    const now = new Date().toISOString()

    // Drive the homepage hero form (verified 2026-08: form#homepage_hero_form
    // with input[name="q"] accepting names; city/state filter via URL params).
    await page.goto("https://www.spokeo.com", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(4_000)

    const q = await firstVisible(page, [
      '#homepage_hero_form input[name="q"]', // live selector
      'form[action="/search"] input[name="q"]',
      'input[name="q"]',
      'input[aria-label="Search"]',
    ])
    if (!q) throw new Error("Spokeo scan: search box not found")
    await q.fill(identity.fullName)
    await q.press("Enter")
    await page.waitForTimeout(5_000) // results render client-side

    // Spokeo's search lands on a state-filter page (/Name) — then metro, then
    // CITY pages where actual person profiles live as
    //   /First-Last/State/City/p<digits>   (verified 2026-08)
    // Drill straight to the identity's city page.
    const stateSlug = identity.stateCode === "DC" ? "District-of-Columbia" : fullStateName(identity.stateCode)
    const citySlug = identity.city.replace(/\s+/g, "-")
    if (!stateSlug) throw new Error(`Spokeo scan: unknown state code '${identity.stateCode}'`)
    const cityUrl = `https://www.spokeo.com/${encodeURIComponent(identity.fullName)}/${stateSlug}/${encodeURIComponent(citySlug)}`
    await page.goto(cityUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(5_000)

    // Collect person-profile links: /First-Last/State/City/p<digits>
    const anchors = page.locator("a")
    const count = Math.min(await anchors.count(), 200)
    const urls: string[] = []

    for (let i = 0; i < count; i++) {
      const href = await anchors.nth(i).getAttribute("href")
      if (!href) continue
      const url = href.startsWith("http") ? href : `https://www.spokeo.com${href}`
      const m = url.match(/^https:\/\/www\.spokeo\.com\/([A-Za-z0-9-]+)\/([A-Za-z-]+)\/([A-Za-z0-9-]+)\/(p\d+)$/)
      if (!m) continue
      if (!isPersonProfileSlug(m[1], identity)) continue
      if (m[2].toLowerCase() !== stateSlug.toLowerCase()) continue
      urls.push(url.split("?")[0])
    }

    // Visit each profile (capped) and scrape exposed data.
    for (const url of [...new Set(urls)].slice(0, 5)) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(2_500)

        const displayName =
          (await tryInnerText(page, "h1")) ?? decodeURIComponent(url.split("/").pop() ?? "")

        const exposedData: Listing["exposedData"] = {
          addresses: await tryAllTexts(page, [
            '[data-testid="address"]',
            'a[href*="address"]',
            ".address",
          ]),
          phones: await tryAllTexts(page, [
            '[data-testid="phone"]',
            'a[href^="tel:"]',
            ".phone",
          ]),
          age: (await tryAllTexts(page, ['[data-testid="age"]', ".age", 'span[class*="age"]']))[0],
          relatives: await tryAllTexts(page, [
            'a[href*="-F"]',
            '[data-testid="relative"]',
            ".relative",
          ]),
          emails: await tryAllTexts(page, ['[data-testid="email"]', 'a[href^="mailto:"]']),
        }

        for (const k of Object.keys(exposedData) as Array<keyof typeof exposedData>) {
          const v = exposedData[k]
          if (Array.isArray(v) && v.length === 0) delete exposedData[k]
        }

        listings.push({
          id: newId("lst"),
          brokerId: "spokeo",
          identityId: identity.id,
          url,
          displayName,
          exposedData,
          confirmedMine: null,
          firstSeenAt: now,
          lastSeenAt: now,
        })
      } catch {
        continue
      }
    }

    return listings
  },

  // ── match confidence ─────────────────────────────────────────────────────

  verifyMatch(listing, identity): number {
    return scoreMatch(
      listing.displayName,
      identity.fullName,
      listing.exposedData.addresses ?? [],
      identity.city,
      identity.stateCode,
      {
        age: listing.exposedData.age,
        ageRange: identity.ageRange,
        relatives: identity.relatives,
        listingRelatives: listing.exposedData.relatives,
      },
    )
  },

  // ── opt-out: prepare ──────────────────────────────────────────────────────

  async prepareOptOut(page, listing, identity, contactEmail): Promise<FilledOptOutForm> {
    await page.goto(OPTOUT_URL, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2_500)

    // Spokeo's form takes the profile URL directly.
    const urlField = await firstVisible(page, [
      'input[name="url"]',
      'input[placeholder*="www.spokeo.com" i]',
      'input[placeholder*="URL" i]',
      'input[placeholder*="link" i]',
    ])
    if (!urlField) throw new Error("Spokeo opt-out: profile URL field not found")
    await urlField.fill(listing.url)

    const email = await firstVisible(page, [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="mail" i]',
    ])
    if (!email) throw new Error("Spokeo opt-out: email field not found")
    await email.fill(contactEmail)

    const screenshot = await page.screenshot({ fullPage: true })
    return {
      screenshot,
      summary:
        `Submitting Spokeo opt-out for the profile at ${listing.url} using ${contactEmail}. ` +
        "A captcha (if present) is auto-solved at submit; Spokeo emails a confirmation link.",
    }
  },

  // ── opt-out: submit ───────────────────────────────────────────────────────

  async submitOptOut(page, _prepared: PreparedOptOut): Promise<OptOutReceipt> {
    const clicked = await tryClick(page, [
      'button:has-text("Submit")',
      'input[type="submit"]',
      'button[type="submit"]',
    ])
    if (!clicked) throw new Error("Spokeo opt-out: submit button not found")

    await page.waitForTimeout(5_000)
    const banner =
      (await tryInnerText(page, 'div[class*="success"]')) ??
      (await tryInnerText(page, 'div[class*="confirm"]')) ??
      (await tryInnerText(page, "h1")) ??
      "Request submitted — check your email for the confirmation link."

    const screenshot = await page.screenshot({ fullPage: true })
    return { ok: true, message: banner, screenshot, needsEmailConfirmation: true }
  },

  // ── email confirmation ───────────────────────────────────────────────────

  async confirmByEmail(page, confirmationUrl): Promise<void> {
    await page.goto(confirmationUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3_000)
    // Spokeo's confirmation link usually completes removal on click; some
    // variants ask for one more "Confirm" press.
    await tryClick(page, [
      'button:has-text("Confirm")',
      'a:has-text("Confirm")',
      'button:has-text("Remove")',
    ])
    await page.waitForTimeout(2_000)
  },
}

/** State code -> Spokeo's state-page slug (e.g. "WA" -> "Washington"). */
function fullStateName(code: string): string {
  const map: Record<string, string> = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
    MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New-Hampshire",
    NJ: "New-Jersey", NM: "New-Mexico", NY: "New-York", NC: "North-Carolina",
    ND: "North-Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
    RI: "Rhode-Island", SC: "South-Carolina", SD: "South-Dakota", TN: "Tennessee",
    TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West-Virginia", WI: "Wisconsin", WY: "Wyoming",
  }
  return map[code.toUpperCase()] ?? ""
}
