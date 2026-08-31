/**
 * Core domain types for PrivacyJanitor.
 *
 * The flow these types encode:
 *   Identity -> Scan (per broker) -> Listings found -> user disambiguates
 *   ("this is me") -> exposure scoring ranks them -> per-listing opt-out:
 *   agent fills form -> user approves preview -> submit -> (maybe) email
 *   confirmation click -> receipt with evidence -> later: rescan + diff.
 */

/** Who we are searching for. Stored locally, never leaves the machine except
 *  inside broker-site searches (which is the whole point) and tokenized LLM
 *  prompts (see scoring/redact.ts). */
export interface Identity {
  id: string
  fullName: string
  city: string
  stateCode: string // two-letter US state, e.g. "WA"
  /** Optional, improves match confidence on brokers that surface relatives. */
  ageRange?: string // e.g. "25-30"
  /** Optional. Never sent anywhere; used only locally for match scoring. */
  relatives?: string[]
  createdAt: string
}

/** A single broker's data record about the person. */
export interface Listing {
  id: string
  brokerId: string
  identityId: string
  /** URL of the profile page on the broker site. */
  url: string
  /** Broker-displayed name (may differ slightly from identity name). */
  displayName: string
  /** Fields the broker exposes, as scraped. Keyed for LLM risk scoring. */
  exposedData: {
    addresses?: string[]
    phones?: string[]
    emails?: string[]
    relatives?: string[]
    age?: string
    aliases?: string[]
  }
  /** Path to local screenshot evidence of the listing. */
  screenshotPath?: string
  /** null = not yet decided; true = user confirmed it's them; false = rejected. */
  confirmedMine: boolean | null
  /** Raw HTML snippet kept for debugging broken flows. Local only. */
  rawSnippet?: string
  firstSeenAt: string
  /** Last time a rescan saw this listing still live. */
  lastSeenAt: string
}

/** Which step an opt-out is at. */
export type SubmissionStatus =
  | "prepared" // form filled, awaiting user approval of preview
  | "approved" // user approved; submit is queued/running
  | "submitted" // opt-out request sent to broker
  | "awaiting_email" // broker sent confirmation email; waiting on user to paste link
  | "confirmed" // confirmation link clicked; removal in progress at broker
  | "removed" // rescan verified listing is gone
  | "failed" // something broke — see lastError
  | "cancelled" // user changed their mind

export interface Submission {
  id: string
  listingId: string
  status: SubmissionStatus
  createdAt: string
  updatedAt: string
  /** Solari session id of the submit run — evidence replay. */
  submitSessionId?: string
  /** Solari session id of the confirmation-click run. */
  confirmSessionId?: string
  /** Screenshots: preview (filled form pre-approval), submit result page. */
  previewScreenshotPath?: string
  resultScreenshotPath?: string
  /** If a rescan proved removal, when. */
  removedVerifiedAt?: string
  lastError?: string
  attempts: number
}

/** One pass over all brokers for an identity. */
export interface ScanRun {
  id: string
  identityId: string
  startedAt: string
  finishedAt?: string
  /** per-broker outcome for the run summary UI */
  results: Array<{
    brokerId: string
    ok: boolean
    listingsFound: number
    error?: string
  }>
}

/** Re-scan of previously submitted listings, to catch relists. */
export interface RescanRun extends ScanRun {
  /** listings that were 'removed' but are live again */
  relisted: string[]
  /** listings still gone */
  stillRemoved: string[]
}

/** Everything the engine needs to run one broker's flow. Adapters are pure
 *  logic + Solari pages; the engine owns sessions, evidence, and store. */
export type MatchConfidence = number // 0..1

export interface BrokerAdapter {
  readonly id: string
  readonly name: string
  readonly homepage: string
  /** Human summary of what the official opt-out requires. Shown in UI. */
  readonly optOutInfo: string

  /** Search the broker for the identity, return candidate listings.
   *  The engine provides the page (stealth session already launched). */
  scan(page: BrokerPage, identity: Identity): Promise<Listing[]>

  /** How likely is it that this listing is the identity (vs a namesake)?
   *  0..1. Engine combines with user confirmation. */
  verifyMatch(listing: Listing, identity: Identity): MatchConfidence

  /** Drive the broker's opt-out form up to (but NOT including) the final
   *  submit. Return a preview the engine screenshots for user approval. */
  prepareOptOut(
    page: BrokerPage,
    listing: Listing,
    identity: Identity,
    contactEmail: string,
  ): Promise<FilledOptOutForm>

  /** Submit the already-prepared opt-out. Called only after user approval. */
  submitOptOut(page: BrokerPage, prepared: PreparedOptOut): Promise<OptOutReceipt>

  /** Some brokers email a confirmation link after submission. */
  readonly expectsEmailConfirmation: boolean
  /** If true, paste the confirmation URL here to finish the flow. */
  confirmByEmail?(page: BrokerPage, confirmationUrl: string): Promise<void>
}

/** Minimal page surface adapters need. Mirrors the subset of Playwright's
 *  Page API that the SDK's browser exposes, so adapters stay testable. */
export interface BrokerPage {
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<void>
  locator(selector: string): BrokerLocator
  waitForTimeout(ms: number): Promise<void>
  url(): string
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>
}

export interface BrokerLocator {
  click(): Promise<void>
  fill(value: string): Promise<void>
  type(text: string): Promise<void>
  selectOption(value: string): Promise<void>
  press(key: string): Promise<void>
  first(): BrokerLocator
  nth(index: number): BrokerLocator
  waitFor(state?: "visible" | "hidden" | "attached" | "detached"): Promise<void>
  innerText(): Promise<string>
  allInnerTexts(): Promise<string[]>
  count(): Promise<number>
  isVisible(): Promise<boolean>
  getAttribute(name: string): Promise<string | null>
}

/** Filled form snapshot returned by prepareOptOut, pre-submission. */
export interface FilledOptOutForm {
  /** Screenshot of the form as filled, for the approval UI. */
  screenshot: Buffer
  /** Structured description of what will be submitted. */
  summary: string
}

/** What the engine keeps between prepare and submit. */
export interface PreparedOptOut {
  listingId: string
  brokerId: string
  /** Serialized state the adapter needs to finish (e.g. form URL, token). */
  state: Record<string, string>
  createdAt: string
}

/** Result of a submitted opt-out. */
export interface OptOutReceipt {
  ok: boolean
  /** What the broker page showed after submit ("request received" etc). */
  message: string
  /** Screenshot of the result page. */
  screenshot?: Buffer
  /** If the broker demanded an email confirmation before/after submit. */
  needsEmailConfirmation: boolean
}
