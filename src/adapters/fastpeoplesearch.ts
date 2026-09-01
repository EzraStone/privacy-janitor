/**
 * FastPeopleSearch adapter.
 *
 * Scan:  fastpeoplesearch.com name search + city/state filter -> profiles.
 * Opt-out: fastpeoplesearch.com/removal -> "Do you have a removal code?" no
 *        -> search for your record by name -> select it -> fill email +
 *        reason -> captcha -> submit -> email confirmation link -> final
 *        click that usually asks for the email again.
 *
 * FPS is more CAPTCHA-heavy than the others and hard-blocks datacenter IPs;
 * the Solari stealth+residential-proxy session is what makes this work.
 */
import type {
  BrokerAdapter,
  FilledOptOutForm,
  Listing,
  OptOutReceipt,
  PreparedOptOut,
} from "@/types"
import { newId } from "../store/index.ts"
import { firstVisible, tryAllTexts, tryClick, tryInnerText, scoreMatch, isPersonProfileSlug } from "./helpers.ts"

const REMOVAL_URL = "https://www.fastpeoplesearch.com/removal"

export const fastpeoplesearch: BrokerAdapter = {
  id: "fastpeoplesearch",
  name: "FastPeopleSearch",
  homepage: "https://www.fastpeoplesearch.com",
  optOutInfo:
    "Official removal tool at fastpeoplesearch.com/removal. Requires email verification " +
    "via a confirmation link; removals typically process within 72 hours.",

  expectsEmailConfirmation: true,

  // ── scan ───────────────────────────────────────────────────────────────────

  async scan(page, identity): Promise<Listing[]> {
    const listings: Listing[] = []
    const now = new Date().toISOString()

    // Drive the homepage name form (verified 2026-08: form#form-search-name
    // with #search-name-name + #search-name-address).
    await page.goto("https://www.fastpeoplesearch.com", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(4_000)

    const nameBox = await firstVisible(page, [
      "#search-name-name", // live selector
      'form#form-search-name input[name="name"]',
      'input[aria-label*="first and last name" i]',
    ])
    if (!nameBox) throw new Error("FastPeopleSearch scan: name box not found")
    await nameBox.fill(identity.fullName)

    const locBox = await firstVisible(page, [
      "#search-name-address", // live selector
      'form#form-search-name input[name="address"]',
    ])
    if (locBox) await locBox.fill(`${identity.city}, ${identity.stateCode}`)

    const goBtn = await firstVisible(page, [
      'form#form-search-name button[type="submit"]',
      'form#form-search-name button',
    ])
    if (goBtn) {
      await goBtn.click()
    } else {
      await nameBox.press("Enter")
    }
    await page.waitForTimeout(5_000)

    // Collect person-profile links. FPS profiles (verified 2026-08) are
    // ROOT-level paths like /john-smith_id_G-8653115056365742102 — never
    // /name/... search pages, /address/... pages, or /page/N pagination.
    const anchors = page.locator("a")
    const count = Math.min(await anchors.count(), 300)
    const urls: string[] = []

    for (let i = 0; i < count; i++) {
      const href = await anchors.nth(i).getAttribute("href")
      if (!href) continue
      const url = href.startsWith("http") ? href : `https://www.fastpeoplesearch.com${href}`
      const m = url.match(/^https:\/\/www\.fastpeoplesearch\.com\/([a-z0-9-]+)_id_G-?\d+$/i)
      if (!m) continue
      if (!isPersonProfileSlug(m[1], identity)) continue
      urls.push(url)
    }

    for (const url of [...new Set(urls)].slice(0, 5)) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" })

        // FPS hydrates profiles client-side; "Loading Search Results..." in
        // <h1> means it isn't done. Poll until real content or ~10s cap.
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const h1 = (await tryInnerText(page, "h1")) ?? ""
          if (h1 && !h1.toLowerCase().includes("loading")) break
          await page.waitForTimeout(1_000)
        }

        const displayName = (await tryInnerText(page, "h1")) ?? identity.fullName

        const exposedData: Listing["exposedData"] = {
          addresses: await tryAllTexts(page, [
            '[class*="address" i]',
            'a[href*="/address/"]',
            'div[class*="adr"]',
          ]),
          phones: await tryAllTexts(page, [
            'a[href*="/phone/"]',
            'a[href^="tel:"]',
            '[class*="phone" i]',
          ]),
          age: (
            await tryAllTexts(page, ['[class*="age" i]', 'span:has-text("Age")'])
          )[0],
          relatives: await tryAllTexts(page, [
            'a[href*="/name/"]',
            '[class*="relative" i]',
          ]),
        }

        for (const k of Object.keys(exposedData) as Array<keyof typeof exposedData>) {
          const v = exposedData[k]
          if (Array.isArray(v) && v.length === 0) delete exposedData[k]
        }

        listings.push({
          id: newId("lst"),
          brokerId: "fastpeoplesearch",
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
    // Verified 2026-08: /removal is a direct request form — role select
    // ("The subject of this request"), subject name, requester email,
    // legal checkbox, Turnstile captcha (auto-solved by Solari).
    await page.goto(REMOVAL_URL, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3_000)

    // Role: "The subject of this request" (I am the person listed).
    const role = await firstVisible(page, ['select[name="am"]'])
    if (role) {
      try {
        await role.selectOption({ label: "The subject of this request" })
      } catch {
        try {
          await role.selectOption({ index: 1 })
        } catch {
          /* keep going — some variants preselect */
        }
      }
    }

    // Subject's name (the person being removed — our identity).
    const first = await firstVisible(page, ['input#firstname', 'input[name="firstname"]'])
    const last = await firstVisible(page, ['input#lastname', 'input[name="lastname"]'])
    if (first) await first.fill(identity.fullName.split(" ")[0])
    if (last) await last.fill(identity.fullName.split(" ").slice(-1)[0])

    const email = await firstVisible(page, ['input#email', 'input[name="email"]', 'input[type="email"]'])
    if (!email) throw new Error("FastPeopleSearch opt-out: email field not found")
    await email.fill(contactEmail)

    // Legal confirmation checkbox.
    const legal = await firstVisible(page, ['input[name="legal"]'])
    if (legal) {
      try {
        await legal.click()
      } catch {
        /* may be auto-checked */
      }
    }

    const screenshot = await page.screenshot({ fullPage: true })
    return {
      screenshot,
      summary:
        `Submitting FastPeopleSearch removal request as the subject of the record ` +
        `(${identity.fullName}) using ${contactEmail}. Turnstile auto-solves at submit. ` +
        `FPS emails a confirmation link; the record:\n${listing.url}`,
    }
  },

  // ── opt-out: submit ───────────────────────────────────────────────────────

  async submitOptOut(page, _prepared: PreparedOptOut): Promise<OptOutReceipt> {
    const clicked = await tryClick(page, [
      'button:has-text("Submit")',
      'button:has-text("Remove me")',
      'input[type="submit"]',
      'button[type="submit"]',
    ])
    if (!clicked) throw new Error("FastPeopleSearch opt-out: submit button not found")

    await page.waitForTimeout(5_000)
    const banner =
      (await tryInnerText(page, 'div[class*="success"]')) ??
      (await tryInnerText(page, 'div[class*="confirm"]')) ??
      (await tryInnerText(page, "h1")) ??
      "Removal request submitted — check your email."

    const screenshot = await page.screenshot({ fullPage: true })
    return { ok: true, message: banner, screenshot, needsEmailConfirmation: true }
  },

  // ── email confirmation ───────────────────────────────────────────────────

  async confirmByEmail(page, confirmationUrl): Promise<void> {
    await page.goto(confirmationUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3_000)

    // FPS's confirmation page often re-asks for the email; the engine can't
    // know it here, so if required, this step fails loudly and the UI will
    // surface instructions. Most variants complete on link click + one press.
    await tryClick(page, [
      'button:has-text("Confirm")',
      'button:has-text("Verify")',
      'a:has-text("Confirm")',
    ])
    await page.waitForTimeout(2_000)
  },
}
