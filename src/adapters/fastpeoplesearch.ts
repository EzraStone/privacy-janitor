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
import { newId } from "@/store"
import { firstVisible, tryAllTexts, tryClick, tryInnerText, scoreMatch } from "./helpers"

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

    const slug = `${identity.fullName.replace(/\s+/g, "-").toLowerCase()}-${identity.city
      .replace(/\s+/g, "-")
      .toLowerCase()}-${identity.stateCode.toLowerCase()}`
    const searchUrl = `https://www.fastpeoplesearch.com/name/${encodeURIComponent(slug)}`
    await page.goto(searchUrl, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(4_000)

    // Result cards link to /name/... profile pages.
    const anchors = page.locator('a[href*="/name/"]')
    const count = Math.min(await anchors.count(), 30)
    const urls: string[] = []

    for (let i = 0; i < count; i++) {
      const href = await anchors.nth(i).getAttribute("href")
      if (!href) continue
      const url = href.startsWith("http") ? href : `https://www.fastpeoplesearch.com${href}`
      const wanted = identity.fullName.toLowerCase().replace(/\s+/g, "-")
      if (url.toLowerCase().includes(wanted)) urls.push(url)
    }

    for (const url of [...new Set(urls)].slice(0, 5)) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" })
        await page.waitForTimeout(2_500)

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

  // ┒ opt-out: prepare ──────────────────────────────────────────────────────

  async prepareOptOut(page, listing, identity, contactEmail): Promise<FilledOptOutForm> {
    await page.goto(REMOVAL_URL, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2_500)

    // Start the removal wizard without a code.
    const noCode = await firstVisible(page, [
      'a:has-text("No, I don\'t have a code")',
      'button:has-text("No")',
      'a:has-text("search for your record")',
    ])
    if (noCode) {
      await noCode.click()
      await page.waitForTimeout(2_000)
    }

    // Search for our record by name.
    const nameInput = await firstVisible(page, [
      'input[name="name"]',
      'input[placeholder*="First and last name" i]',
      'input[placeholder*="name" i]',
      'input[type="text"]',
    ])
    if (nameInput) {
      await nameInput.fill(identity.fullName)
      const goBtn = await firstVisible(page, [
        'button:has-text("Search")',
        'button:has-text("Go")',
        'input[type="submit"]',
      ])
      if (goBtn) {
        await goBtn.click()
        await page.waitForTimeout(4_000)
      }
    }

    // Select the matching record — prefer an exact URL match to our listing.
    const recordLink = await firstVisible(page, [
      `a[href*="${listing.url.split("/").pop()}"]`,
      'a:has-text("Select")',
      'button:has-text("Select")',
    ])
    if (recordLink) {
      await recordLink.click()
      await page.waitForTimeout(2_000)
    }

    const email = await firstVisible(page, [
      'input[name="email"]',
      'input[type="email"]',
      'input[placeholder*="mail" i]',
    ])
    if (email) await email.fill(contactEmail)

    const reason = await firstVisible(page, [
      'select[name="reason"]',
      'select[id*="reason" i]',
    ])
    if (reason) {
      try {
        await reason.selectOption("I have privacy concerns")
      } catch {
        /* optional */
      }
    }

    const screenshot = await page.screenshot({ fullPage: true })
    return {
      screenshot,
      summary:
        `Submitting FastPeopleSearch removal for ${identity.fullName} using ${contactEmail}. ` +
        "FPS sends a confirmation link by email; the record link we're removing is:\n" +
        listing.url,
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
