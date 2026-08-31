/**
 * Whitepages adapter.
 *
 * Scan:  site search by name + city/state -> profile cards -> per-profile
 *        extraction of exposed data.
 * Opt-out: whitepages.com/suppression_requests -> name/city/state lookup ->
 *        select record -> removal reason -> email + captcha -> submit ->
 *        email confirmation link (user pastes) -> final confirm click.
 *
 * NOTE: broker DOMs change without notice. Selectors here use layered
 * fallbacks; the smoke test (scripts/smoke.mjs) catches drift early.
 * Whitepages hard-blocks non-browser clients, so every flow here REQUIRES
 * the Solari stealth session the engine provides.
 */
import type {
  BrokerAdapter,
  BrokerPage,
  FilledOptOutForm,
  Identity,
  Listing,
  OptOutReceipt,
  PreparedOptOut,
} from "@/types"
import { newId } from "@/store"

const SUPPRESSION_URL = "https://www.whitepages.com/suppression_requests"

/** Extra state carried between prepare and submit. */
interface WpState {
  listingId: string
  /** URL of the suppression form with the record selected, if the flow
   *  deep-links; otherwise we re-drive from search. */
  formUrl?: string
}

export const whitepages: BrokerAdapter = {
  id: "whitepages",
  name: "Whitepages",
  homepage: "https://www.whitepages.com",
  optOutInfo:
    "Official suppression-request form. Requires an email address and a captcha; " +
    "Whitepages emails a confirmation link you must click within 72 hours. " +
    "Removal typically completes within a few days.",

  expectsEmailConfirmation: true,

  // ── scan ───────────────────────────────────────────────────────────────────

  async scan(page, identity): Promise<Listing[]> {
    const listings: Listing[] = []
    const now = new Date().toISOString()

    // 1. Load homepage and use the search form.
    await page.goto("https://www.whitepages.com", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2_000) // settle anti-bot interstitials

    const firstName = identity.fullName.split(" ")[0]
    const lastName = identity.fullName.split(" ").slice(-1)[0]
    const location = `${identity.city}, ${identity.stateCode}`

    const nameInput = await firstVisible(page, [
      'input[name="search_term"]',
      'input[placeholder*="Name"]',
      'input[aria-label*="Name"]',
      'input[type="text"]',
    ])
    if (!nameInput) throw new Error("Whitepages scan: could not find the name search box")
    await nameInput.fill(`${firstName} ${lastName}`)

    const locInput = await firstVisible(page, [
      'input[name="search_location"]',
      'input[placeholder*="city"]',
      'input[placeholder*="City"]',
      'input[aria-label*="location"]',
    ])
    if (locInput) await locInput.fill(location)

    await pressEnter(nameInput)
    await page.waitForTimeout(4_000) // results render client-side

    // 2. Collect profile links from result cards.
    const profileUrls = await extractProfileUrls(page, identity)

    // 3. Visit each profile (capped) and scrape exposed data.
    for (const url of profileUrls.slice(0, 5)) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(2_500)

        const displayName =
          (await tryInnerText(page, 'h1')) ?? identity.fullName

        const exposedData: Listing["exposedData"] = {
          addresses: await tryAllTexts(page, [
            '[data-testid="address"]',
            ".address",
            'div[class*="address"]',
          ]),
          phones: await tryAllTexts(page, [
            '[data-testid="phone"]',
            ".phone",
            'a[href^="tel:"]',
          ]),
          age: (await tryAllTexts(page, ['[data-testid="age"]', ".age", 'span[class*="age"]']))[0],
          relatives: await tryAllTexts(page, [
            '[data-testid="relative"]',
            'a[href*="/relative/"]',
            ".relative",
          ]),
          aliases: await tryAllTexts(page, ['[data-testid="alias"]', ".alias"]),
        }

        // Prune empties so the UI shows only what's really exposed.
        for (const k of Object.keys(exposedData) as Array<keyof typeof exposedData>) {
          const v = exposedData[k]
          if (Array.isArray(v) && v.length === 0) delete exposedData[k]
        }

        listings.push({
          id: newId("lst"),
          brokerId: "whitepages",
          identityId: identity.id,
          url,
          displayName,
          exposedData,
          confirmedMine: null,
          firstSeenAt: now,
          lastSeenAt: now,
        })
      } catch {
        // A bad profile page shouldn't kill the whole scan.
        continue
      }
    }

    return listings
  },

  // ── match confidence ─────────────────────────────────────────────────────

  verifyMatch(listing, identity): number {
    let score = 0
    const name = listing.displayName.toLowerCase()
    const wanted = identity.fullName.toLowerCase()
    if (name === wanted) score += 0.4
    else if (name.includes(wanted) || wanted.includes(name)) score += 0.25

    const addrs = listing.exposedData.addresses ?? []
    const state = identity.stateCode.toLowerCase()
    const city = identity.city.toLowerCase()
    if (addrs.some((a) => a.toLowerCase().includes(city) && a.toLowerCase().includes(state)))
      score += 0.3
    else if (addrs.some((a) => a.toLowerCase().includes(state))) score += 0.15

    if (listing.exposedData.age && identity.ageRange) {
      const age = parseInt(listing.exposedData.age, 10)
      const [lo, hi] = identity.ageRange.split("-").map((x) => parseInt(x, 10))
      if (age >= lo && age <= hi) score += 0.2
    }

    if (identity.relatives?.length && listing.exposedData.relatives?.length) {
      const mine = identity.relatives.map((r) => r.toLowerCase().split(" ")[0])
      const theirs = listing.exposedData.relatives.map((r) => r.toLowerCase().split(" ")[0])
      if (mine.some((m) => theirs.includes(m))) score += 0.1
    }

    return Math.min(score, 1)
  },

  // ── opt-out: prepare (fills, screenshots, does NOT submit) ────────────────

  async prepareOptOut(page, listing, identity, contactEmail): Promise<FilledOptOutForm> {
    await page.goto(SUPPRESSION_URL, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2_500)

    const firstName = identity.fullName.split(" ")[0]
    const lastName = identity.fullName.split(" ").slice(-1)[0]

    // Layered fallbacks; suppression form labels have shifted over the years.
    const first = await firstVisible(page, [
      'input[name="first_name"]',
      'input[id*="first" i]',
      'input[placeholder*="First" i]',
    ])
    const last = await firstVisible(page, [
      'input[name="last_name"]',
      'input[id*="last" i]',
      'input[placeholder*="Last" i]',
    ])
    if (!first || !last) throw new Error("Whitepages opt-out: name fields not found")
    await first.fill(firstName)
    await last.fill(lastName)

    const cityState = await firstVisible(page, [
      'input[name="city_state"]',
      'input[id*="city" i]',
      'input[placeholder*="City" i]',
    ])
    if (cityState) await cityState.fill(`${identity.city}, ${identity.stateCode}`)

    const stateSelect = await firstVisible(page, ['select[name="state"]', 'select[id*="state" i]'])
    if (stateSelect) await stateSelect.selectOption(identity.stateCode)

    const searchBtn = await firstVisible(page, [
      'button:has-text("Search")',
      'input[type="submit"]',
      'button[type="submit"]',
    ])
    if (searchBtn) {
      await searchBtn.click()
      await page.waitForTimeout(4_000)
    }

    // Find and select the record matching our listing URL.
    const recordLink = await firstVisible(page, [
      `a[href*="${listingIdSegment(listing.url)}"]`,
      'a:has-text("Remove")',
      'a:has-text("Remove me")',
      'button:has-text("Remove")',
    ])
    if (recordLink) {
      await recordLink.click()
      await page.waitForTimeout(3_000)
    }

    // Removal reason, if the flow asks.
    const reason = await firstVisible(page, [
      'select[name="reason"]',
      'select[id*="reason" i]',
      'input[value*="privacy" i]',
      'label:has-text("privacy")',
    ])
    if (reason) {
      try {
        await reason.selectOption("I have privacy concerns")
      } catch {
        try {
          await reason.click()
        } catch {
          /* optional field */
        }
      }
    }

    const email = await firstVisible(page, [
      'input[name="email"]',
      'input[type="email"]',
      'input[id*="email" i]',
    ])
    if (!email) throw new Error("Whitepages opt-out: email field not found")
    await email.fill(contactEmail)

    const phone = await firstVisible(page, [
      'input[name="phone"]',
      'input[type="tel"]',
      'input[id*="phone" i]',
    ])
    if (phone) await phone.fill((listing.exposedData.phones ?? [""])[0] ?? "")

    const captchaOk = await firstVisible(page, [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      '[class*="captcha"]',
    ])
    // Solari auto-solves during submit when captcha:true is set on launch.

    const screenshot = await page.screenshot({ fullPage: true })
    return {
      screenshot,
      summary:
        `Submitting Whitepages suppression request for ${identity.fullName} ` +
        `(${identity.city}, ${identity.stateCode}) using ${contactEmail}. ` +
        (captchaOk ? "A captcha will be auto-solved at submit time. " : "") +
        "Whitepages will email a confirmation link you must click.",
    }
  },

  // ── opt-out: submit (only after user approval) ────────────────────────────

  async submitOptOut(page, prepared: PreparedOptOut): Promise<OptOutReceipt> {
    const submitBtn = await firstVisible(page, [
      'button:has-text("Submit")',
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Remove")',
    ])
    if (!submitBtn) throw new Error("Whitepages opt-out: submit button not found")

    await submitBtn.click()

    // Post-submit: confirmation banner or email-pending notice.
    await page.waitForTimeout(5_000)
    const banner =
      (await tryInnerText(page, 'div[class*="success"]')) ??
      (await tryInnerText(page, 'div[class*="confirm"]')) ??
      (await tryInnerText(page, "h1")) ??
      "Request submitted. Check your email for the confirmation link."

    const screenshot = await page.screenshot({ fullPage: true })
    return {
      ok: true,
      message: banner,
      screenshot,
      needsEmailConfirmation: true,
    }
  },

  // ── email confirmation ───────────────────────────────────────────────────

  async confirmByEmail(page, confirmationUrl): Promise<void> {
    await page.goto(confirmationUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3_000)

    // Some confirmation pages need one final "Confirm removal" click.
    const finalBtn = await firstVisible(page, [
      'button:has-text("Confirm")',
      'a:has-text("Confirm")',
      'button:has-text("Remove")',
    ])
    if (finalBtn) await finalBtn.click()
    await page.waitForTimeout(2_000)
  },
}

// ── helpers ────────────────────────────────────────────────────────────────

function listingIdSegment(listingUrl: string): string {
  // Whitepages profile URLs look like /name/John-Smith/5hvHk7 — the trailing
  // segment is the stable record id we can match against in the suppression
  // search results.
  const segs = listingUrl.split("/").filter(Boolean)
  return segs[segs.length - 1] ?? ""
}

async function extractProfileUrls(page: BrokerPage, identity: Identity): Promise<string[]> {
  const wanted = identity.fullName.toLowerCase().replace(/\s+/g, "-")
  const hrefs: string[] = []

  const anchors = page.locator('a[href*="/name/"]')
  const count = await anchors.count()
  for (let i = 0; i < count && i < 30; i++) {
    const href = await anchors.nth(i).getAttribute("href")
    if (!href) continue
    const url = href.startsWith("http") ? href : `https://www.whitepages.com${href}`
    if (!url.includes("/name/")) continue
    if (url.toLowerCase().includes(wanted)) hrefs.push(url)
  }

  // De-dupe, keep order.
  return [...new Set(hrefs)]
}

async function firstVisible(
  page: BrokerPage,
  selectors: string[],
): Promise<import("@/types").BrokerLocator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    try {
      if (await loc.isVisible()) return loc
    } catch {
      /* selector invalid on this DOM */
    }
  }
  return null
}

async function tryInnerText(page: BrokerPage, selector: string): Promise<string | undefined> {
  try {
    const loc = page.locator(selector).first()
    if (await loc.isVisible()) return (await loc.innerText()).trim()
  } catch {
    /* not present */
  }
  return undefined
}

async function tryAllTexts(page: BrokerPage, selectors: string[]): Promise<string[]> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel)
      if ((await loc.count()) > 0) {
        const texts = await loc.allInnerTexts()
        const clean = texts.map((t) => t.trim()).filter(Boolean)
        if (clean.length) return clean.slice(0, 10)
      }
    } catch {
      /* try next */
    }
  }
  return []
}

async function pressEnter(loc: import("@/types").BrokerLocator): Promise<void> {
  await loc.press("Enter")
}
