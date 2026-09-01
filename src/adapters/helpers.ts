/**
 * DOM helpers shared by all broker adapters. Broker DOMs drift constantly,
 * so every lookup is layered fallbacks + try/catch — a broken selector must
 * degrade, never crash a whole scan.
 */
import type { BrokerPage, BrokerLocator } from "@/types"

/** First visible locator among fallback selectors, or null. */
export async function firstVisible(
  page: BrokerPage,
  selectors: string[],
): Promise<BrokerLocator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    try {
      if (await loc.isVisible()) return loc
    } catch {
      /* invalid selector on this DOM — try next */
    }
  }
  return null
}

/** Inner text of the first visible match, or undefined. */
export async function tryInnerText(
  page: BrokerPage,
  selector: string,
): Promise<string | undefined> {
  try {
    const loc = page.locator(selector).first()
    if (await loc.isVisible()) return (await loc.innerText()).trim()
  } catch {
    /* not present */
  }
  return undefined
}

/** All inner texts (capped) across the first selector that matches. */
export async function tryAllTexts(
  page: BrokerPage,
  selectors: string[],
): Promise<string[]> {
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

/** Click the first visible/clickable among fallback selectors. */
export async function tryClick(
  page: BrokerPage,
  selectors: string[],
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first()
      if (await loc.isVisible()) {
        await loc.click()
        return true
      }
    } catch {
      /* try next */
    }
  }
  return false
}

/** Wait until one of the selectors is visible; returns which, or null. */
export async function waitForAny(
  page: BrokerPage,
  selectors: string[],
  timeoutMs = 10_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        if (await page.locator(sel).first().isVisible()) return sel
      } catch {
        /* keep polling */
      }
    }
    await page.waitForTimeout(500)
  }
  return null
}

/** Standardized match scoring shared by adapters. */
export function scoreMatch(
  displayName: string,
  identityName: string,
  addresses: string[],
  city: string,
  stateCode: string,
  extras?: { age?: string; ageRange?: string; relatives?: string[]; listingRelatives?: string[] },
): number {
  let score = 0
  const name = displayName.toLowerCase()
  const wanted = identityName.toLowerCase()
  if (name === wanted) score += 0.4
  else if (name.includes(wanted) || wanted.includes(name)) score += 0.25

  const state = stateCode.toLowerCase()
  const cityL = city.toLowerCase()
  if (addresses.some((a) => a.toLowerCase().includes(cityL) && a.toLowerCase().includes(state)))
    score += 0.3
  else if (addresses.some((a) => a.toLowerCase().includes(state))) score += 0.15

  if (extras?.age && extras.ageRange) {
    const age = parseInt(extras.age, 10)
    const [lo, hi] = extras.ageRange.split("-").map((x) => parseInt(x, 10))
    if (age >= lo && age <= hi) score += 0.2
  }

  if (extras?.relatives?.length && extras?.listingRelatives?.length) {
    const mine = extras.relatives.map((r) => r.toLowerCase().split(" ")[0])
    const theirs = extras.listingRelatives.map((r) => r.toLowerCase().split(" ")[0])
    if (mine.some((m) => theirs.includes(m))) score += 0.1
  }

  return Math.min(score, 1)
}

/**
 * Does a URL name-slug ("john-arbizu-smith", "jon-d-smith", "john-w-smith-jr")
 * plausibly refer to the identity's full name? Middle names/initials and
 * suffixes are tolerated; first-name shortenings (jon ~ john, johnny ~ john)
 * match on the first two letters. Missing a real listing is worse than
 * showing a namesake — the user confirms listings anyway.
 */
export function isPersonProfileSlug(
  slug: string,
  identity: { fullName: string },
): boolean {
  const tokens = slug.toLowerCase().split("-").filter(Boolean)
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv", "v"])
  while (tokens.length > 2 && suffixes.has(tokens[tokens.length - 1])) tokens.pop()

  const parts = identity.fullName.toLowerCase().split(/\s+/).filter(Boolean)
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (!first || !last || tokens.length < 2) return false

  const lastTok = tokens[tokens.length - 1]
  const firstTok = tokens[0]
  if (lastTok !== last) return false
  return firstTok.startsWith(first.slice(0, 2)) || first.startsWith(firstTok.slice(0, 2))
}
