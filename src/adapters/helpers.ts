/**
 * DOM helpers shared by all broker adapters. Broker DOMs drift constantly,
 * so every lookup is layered fallbacks + try/catch — a broken selector must
 * degrade, never crash a whole scan.
 */
import type {
  BrokerPage,
  BrokerLocator,
  BrokerScanObservation,
  Listing,
} from "@/types"

const CHALLENGE_MARKERS = [
  "verify you are human",
  "checking your browser",
  "unusual traffic",
  "access denied",
  "temporarily blocked",
  "just a moment",
  "complete the captcha",
  "solve the captcha",
  "captcha verification failed",
  "rate limit",
  "too many requests",
]

/**
 * Convert an adapter's search-page evidence into a conservative outcome.
 * Only an explicit broker no-results message may produce `clear`; an unknown
 * empty page is inconclusive and can never verify a removal.
 */
export function classifyBrokerScan(input: {
  listings: Listing[]
  candidateCount: number
  failedProfiles: number
  candidateLimit: number
  searchPageText: string
  explicitNoResults: boolean
  hasMoreResults: boolean
  traversalTruncated?: boolean
}): BrokerScanObservation {
  const pageText = input.searchPageText.toLowerCase()
  const challenge = CHALLENGE_MARKERS.find((marker) => pageText.includes(marker))

  // Challenge text wins even if selectors happened to return stale/partial
  // links. A challenged page cannot prove either presence or absence.
  if (challenge) {
    return {
      outcome: "inconclusive",
      listings: input.listings,
      issueCode: challenge.includes("rate") || challenge.includes("too many")
        ? "rate_limited"
        : "challenge",
      detail: `broker challenge detected: ${challenge}`,
    }
  }

  if (
    input.failedProfiles > 0 ||
    input.candidateCount >= input.candidateLimit ||
    input.hasMoreResults ||
    input.traversalTruncated
  ) {
    const detail = input.failedProfiles > 0
      ? `${input.failedProfiles} candidate profile(s) could not be verified`
      : input.hasMoreResults
        ? "the broker reported another results page"
        : input.traversalTruncated
          ? "the adapter reached its search-page traversal limit"
          : `at least ${input.candidateLimit} candidate profiles were returned`
    return {
      outcome: "inconclusive",
      listings: input.listings,
      issueCode: "partial",
      detail,
    }
  }

  if (input.listings.length > 0) return { outcome: "found", listings: input.listings }

  if (input.explicitNoResults) return { outcome: "clear", listings: [] }

  return {
    outcome: "inconclusive",
    listings: [],
    issueCode: "selector_drift",
    detail: "the broker page did not contain recognized results or a recognized no-results state",
  }
}

const DEFAULT_NO_RESULT_SELECTORS = [
  '[data-testid*="no-result" i]',
  '[data-test*="no-result" i]',
  '[data-component*="no-result" i]',
  '[id*="no-result" i]',
  '[class*="no-result" i]',
  '[class*="empty-state" i]',
]

const DEFAULT_NEXT_PAGE_SELECTORS = [
  'a[rel="next"]',
  'a[aria-label*="next" i]',
  'button[aria-label*="next" i]',
  'a[href*="page=2"]',
  'a[href*="/page/2"]',
  '[class*="pagination" i] a[href*="page"]',
]

/**
 * Inspect the search page while it is still open. A body-wide phrase is useful
 * for challenge detection, but `clear` requires matching text in a visible,
 * result-state-specific element and no visible path to another result page.
 */
export async function inspectBrokerSearchPage(
  page: BrokerPage,
  options: {
    noResultMarkers: string[]
    noResultSelectors?: string[]
    nextPageSelectors?: string[]
  },
): Promise<{
  pageText: string
  explicitNoResults: boolean
  hasMoreResults: boolean
  screenshot?: Buffer
}> {
  const pageText = (await tryInnerText(page, "body")) ?? ""
  const explicitNoResults = await visibleTextContains(
    page,
    [...(options.noResultSelectors ?? []), ...DEFAULT_NO_RESULT_SELECTORS],
    options.noResultMarkers,
  )
  const hasMoreResults = await anyVisible(
    page,
    [...(options.nextPageSelectors ?? []), ...DEFAULT_NEXT_PAGE_SELECTORS],
  )
  const screenshot = await page.screenshot({ fullPage: true }).catch(() => undefined)
  return { pageText, explicitNoResults, hasMoreResults, screenshot }
}

async function visibleTextContains(
  page: BrokerPage,
  selectors: string[],
  markers: string[],
): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const matches = page.locator(selector)
      const count = Math.min(await matches.count(), 10)
      for (let index = 0; index < count; index++) {
        const match = matches.nth(index)
        if (!(await match.isVisible())) continue
        const text = (await match.innerText()).trim().toLowerCase()
        if (isNoResultText(text, markers)) return true
      }
    } catch {
      /* selector drift — inspect the next explicit result-state element */
    }
  }
  return false
}

export function isNoResultText(text: string, markers: string[]): boolean {
  const normalized = text.trim().toLowerCase()
  return markers.some((rawMarker) => {
    const marker = rawMarker.trim().toLowerCase()
    // Avoid treating "10 results" or "20 results" as the marker "0 results".
    if (marker === "0 results") return /(^|[^0-9])0\s+results?\b/.test(normalized)
    return normalized.includes(marker)
  })
}

async function anyVisible(page: BrokerPage, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const matches = page.locator(selector)
      const count = Math.min(await matches.count(), 10)
      for (let index = 0; index < count; index++) {
        if (await matches.nth(index).isVisible()) return true
      }
    } catch {
      /* try the next pagination selector */
    }
  }
  return false
}

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

/** Select a fallback before clicking; never retry a potentially completed action. */
export async function clickOnce(page: BrokerPage, selectors: string[]): Promise<boolean> {
  const button = await firstVisible(page, selectors)
  if (!button) return false
  await button.click()
  return true
}

/** A URL match alone is not evidence that a profile actually loaded. */
export async function requireProfileName(
  page: BrokerPage,
  identity: { fullName: string },
): Promise<string> {
  const body = ((await tryInnerText(page, "body")) ?? "").toLowerCase()
  const heading = await tryInnerText(page, "h1")
  // Fold accents on both sides: brokers print "Garcia" for "García".
  const tokens: string[] = foldName(heading ?? "").match(/[\p{L}\p{N}]+/gu) ?? []
  const wanted: string[] = foldName(identity.fullName).match(/[\p{L}\p{N}]+/gu) ?? []
  if (!heading || CHALLENGE_MARKERS.some((marker) => body.includes(marker)) ||
      /loading|not found|unavailable/i.test(heading) || wanted.length < 2 ||
      !tokens.includes(wanted.at(-1)!) || !tokens.some((token) => token.startsWith(wanted[0].slice(0, 2)))) {
    throw new Error("Profile content could not be verified; no listing was inferred from the search URL.")
  }
  return heading
}

const RECEIPT_SELECTORS = [
  '[role="status"]', '[role="alert"]', '[data-testid*="success" i]',
  'div[class*="success"]', 'div[class*="confirm"]', 'h1',
]
const RECEIPT_ERRORS = /\b(?:not|failed|unable|cannot|invalid|expired|error|required|please enter)\b/i
const REQUEST_ACK = /^(?:thank you[!.,]\s*)?(?:your\s+)?(?:(?:removal|opt-out|suppression)\s+)?request\s+(?:(?:has been|was)\s+)?(?:successfully\s+)?(?:received|submitted|accepted)[.!\s]*$/i
const EMAIL_ACK = /^(?:please\s+)?check your (?:email|inbox)(?: for (?:a |the )?confirmation (?:email|link))?[.!\s]*$/i
const CONFIRM_ACK = /^(?:your\s+)?(?:(?:removal|opt-out|suppression)\s+)?(?:request|email)\s+(?:(?:has been|was|is now)\s+)?(?:successfully\s+)?(?:confirmed|verified)[.!\s]*$/i
const REMOVAL_ACK = /^(?:your\s+)?(?:listing|record|profile|information)\s+(?:(?:has been|was)\s+)(?:successfully\s+)?removed[.!\s]*$/i

/**
 * Require an affirmative, visible broker receipt. These conservative patterns
 * are fixture-tested, not a promise about today's live DOM. Unknown responses
 * throw so the durable workflow asks for review instead of inventing success.
 */
export async function requireBrokerReceipt(page: BrokerPage, stage: "submit" | "confirm"): Promise<string> {
  const body = ((await tryInnerText(page, "body")) ?? "").toLowerCase()
  if (CHALLENGE_MARKERS.some((marker) => body.includes(marker))) {
    throw new Error("Broker challenge remains; the request outcome is uncertain. Review before retrying.")
  }
  if (stage === "confirm" && await firstVisible(page, ['input[type="email"]', 'input[name="email"]', 'input#email'])) {
    throw new Error("Broker confirmation still asks for an email address. Complete it on the official site and review the result.")
  }
  const messages: string[] = []
  for (const selector of RECEIPT_SELECTORS) {
    const matches = page.locator(selector)
    const count = Math.min(await matches.count(), 10)
    for (let index = 0; index < count; index++) {
      const match = matches.nth(index)
      if (await match.isVisible()) messages.push((await match.innerText()).trim())
    }
  }
  // Negative banners win over stale positive banners elsewhere on the page.
  if (messages.some((message) => RECEIPT_ERRORS.test(message))) {
    throw new Error("Broker displayed an error or an unfinished step. Review the page before retrying.")
  }
  for (const message of messages) {
    const sentences = message.split(/(?<=[.!])\s+|\n+/).map((text) => text.trim())
    const accepted = stage === "submit" ? [REQUEST_ACK, EMAIL_ACK, CONFIRM_ACK, REMOVAL_ACK] : [CONFIRM_ACK, REMOVAL_ACK]
    if (stage === "confirm" && /check your (?:email|inbox)|confirmation link|confirm your email/i.test(message)) continue
    if (sentences.some((sentence) => accepted.some((pattern) => pattern.test(sentence)))) return message
  }
  throw new Error("No recognized broker receipt was found. The action may have completed; review before retrying.")
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
/** Lowercase with diacritics removed: brokers print "Garcia" for "García". */
function foldName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

function nameWords(name: string): string[] {
  return foldName(name).split(/[^\p{L}\p{N}']+/u).filter(Boolean)
}

export function scoreMatch(
  displayName: string,
  identityName: string,
  addresses: string[],
  city: string,
  stateCode: string,
  extras?: { age?: string; ageRange?: string; relatives?: string[]; listingRelatives?: string[] },
): number {
  let score = 0
  // Compare names as words, not substrings: a middle initial ("Jordan A
  // Example") still matches, a fragment ("Jo") does not, and accents a broker
  // stripped ("Jose" for "José") are folded away on both sides.
  const shown = nameWords(displayName)
  const wanted = nameWords(identityName)
  const covers = (all: string[], some: string[]) => some.length > 0 && some.every((w) => all.includes(w))
  if (shown.length > 0 && shown.join(" ") === wanted.join(" ")) score += 0.4
  else if (covers(shown, wanted) || covers(wanted, shown)) score += 0.25

  // A two-letter state code is a word, not a substring: "ma" is inside
  // "main", "ca" inside "chicago", "il" inside "hill".
  const state = stateCode.toLowerCase().replace(/[^a-z]/g, "")
  const inState = (a: string) => state !== "" && new RegExp(`\\b${state}\\b`).test(a.toLowerCase())
  const cityL = city.toLowerCase()
  if (addresses.some((a) => a.toLowerCase().includes(cityL) && inState(a))) score += 0.3
  else if (addresses.some(inState)) score += 0.15

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
  let decoded = slug
  try {
    decoded = decodeURIComponent(slug)
  } catch {
    /* keep a malformed slug as it is */
  }
  const tokens = foldName(decoded).split("-").filter(Boolean)
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv", "v"])
  while (tokens.length > 2 && suffixes.has(tokens[tokens.length - 1])) tokens.pop()

  // Compare letters only. A slug drops accents ("garcia"), apostrophes
  // ("obrien" or "o-brien") and splits hyphenated surnames ("smith-jones"),
  // so the surname may span several trailing tokens.
  const letters = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "")
  const parts = foldName(identity.fullName).split(/\s+/).filter(Boolean)
  const first = letters(parts[0] ?? "")
  const last = letters(parts[parts.length - 1] ?? "")
  if (!first || !last || tokens.length < 2) return false

  // At least one leading token must remain for the first name.
  let surnameFound = false
  for (let k = 1; k < tokens.length && !surnameFound; k++) {
    surnameFound = letters(tokens.slice(-k).join("")) === last
  }
  if (!surnameFound) return false
  const firstTok = letters(tokens[0])
  return firstTok.startsWith(first.slice(0, 2)) || first.startsWith(firstTok.slice(0, 2))
}
