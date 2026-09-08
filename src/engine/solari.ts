/**
 * Solari session engine.
 *
 * Every broker interaction runs through here so all sessions get the same
 * recipe: stealth + captcha solving + session recording + a sticky US
 * residential proxy (one consistent egress IP per run, so brokers don't see
 * us hop countries mid-flow).
 *
 * Encodes the Solari cookbook gotchas:
 *   - ALWAYS close the browser. On the pinned 0.1.1 the process never exits
 *     if you skip it; 0.1.3+ unrefs the listener, but closing still matters —
 *     an unclosed session keeps burning cloud browser time either way.
 *   - replay uploads are async — poll getReplayUrl for up to ~30s
 *   - stealth is a prerequisite for proxy + captcha
 */
import { Solari } from "@solarisdk/browser"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BrokerPage } from "@/types"
import { getEvidenceDir } from "../config/paths.ts"

export interface RunEvidence {
  runId: string
  evidenceDir: string
  screenshot: (name: string, png: Buffer) => string // returns saved path
  sessionId?: string
  replayUrl?: string
}

export function getSolariClient(): Solari {
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey || apiKey.startsWith("slr_live_xxx")) {
    throw new Error(
      "SOLARI_API_KEY is not set. Copy .env.example to .env and add your key from https://console.getsolari.com",
    )
  }
  return new Solari({
    apiKey,
    baseUrl: "https://api.getsolari.com",
  })
}

/**
 * Solari caps the sticky-proxy session id at 32 characters, and run ids are
 * human-readable enough to blow past it — `confirm-fastpeoplesearch-<ts>` is
 * already 33. An over-long id is not a loud failure: it costs you the pin, so
 * the residential egress rotates mid-flow and the broker sees the form load
 * and the submit arrive from different IPs. That is indistinguishable from a
 * session hijack, and it gets you challenged partway through a flow that was
 * working a second earlier.
 *
 * Keep as much of the readable run id as fits, then a short digest so two runs
 * sharing a prefix still pin to different egress IPs.
 */
const MAX_PROXY_SESSION_ID = 32

export function proxySessionId(runId: string): string {
  if (runId.length <= MAX_PROXY_SESSION_ID) return runId
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 8)
  return `${runId.slice(0, MAX_PROXY_SESSION_ID - digest.length - 1)}-${digest}`
}

/**
 * Minutes to hold one egress IP. Solari accepts 1-30, and the pin lapses on
 * the clock rather than on flow completion — so this is a hard ceiling on how
 * long a single broker flow can run before its IP rotates underneath it. 30 is
 * the maximum the API allows; there is no headroom left to buy.
 */
const PROXY_SESSION_MINUTES = 30

/** Launch options that degrade to the free plan when stealth is paywalled. */
const STEALTH_RECIPE = {
  stealth: true,
  captcha: true,
  recording: true,
  proxy: { country: "us", session: "", sessionDuration: PROXY_SESSION_MINUTES },
} as const

const DEFAULT_RECIPE = {
  recording: true,
} as const

export async function launchResilient(
  client: Solari,
  runId: string,
): Promise<{ browser: Awaited<ReturnType<Solari["launch"]>>; stealth: boolean }> {
  try {
    const browser = await client.launch({
      ...STEALTH_RECIPE,
      proxy: {
        country: "us",
        session: proxySessionId(runId),
        sessionDuration: PROXY_SESSION_MINUTES,
      },
    })
    return { browser, stealth: true }
  } catch (err) {
    // 402 FeatureRequiresPlan: free plan has no stealth/captcha/proxy.
    // Degrade to the default browser rather than fail the whole run.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("FeatureRequiresPlan") || msg.includes("paid plan")) {
      console.warn(
        `[solari] stealth mode unavailable on this plan — falling back to the default browser. ` +
          `Scans still work on most brokers; captcha-gated opt-outs need a paid plan.`,
      )
      const browser = await client.launch(DEFAULT_RECIPE)
      return { browser, stealth: false }
    }
    throw err
  }
}

/**
 * Run a broker flow inside a stealth session with guaranteed cleanup.
 * The callback receives a real Playwright page; everything it does is
 * recorded and screenshottable.
 */
export async function withBrokerSession<T>(
  flowName: string,
  fn: (
    page: BrokerPage,
    evidence: RunEvidence,
    rawPage: Page,
  ) => Promise<T>,
): Promise<{ result: T; evidence: RunEvidence }> {
  const client = getSolariClient()
  const runId = `${flowName}-${Date.now().toString(36)}`
  const evidenceDir = join(getEvidenceDir(), runId)
  mkdirSync(evidenceDir, { recursive: true })

  const evidence: RunEvidence = {
    runId,
    evidenceDir,
    screenshot: (name: string, png: Buffer) => {
      const p = join(evidenceDir, `${name}.png`)
      writeFileSync(p, png)
      return p
    },
  }

  const { browser } = await launchResilient(client, runId)

  evidence.sessionId = browser.id

  try {
    const rawPage = await browser.newPage()
    // Wrap (NOT mutate) the Playwright page — adapters get the BrokerPage
    // surface; orchestrator code needing raw Playwright APIs uses rawPage.
    const page = adaptPage(rawPage)
    const result = await fn(page, evidence, rawPage)
    return { result, evidence }
  } finally {
    await browser.close() // never skip: hangs on 0.1.1, leaks the session on any version
  }
}

/** Fetch the replay URL for a finished session. Uploads are async; poll. */
export async function getReplayUrl(sessionId: string): Promise<string | undefined> {
  const client = getSolariClient()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const { url } = await client.sessions.getReplayUrl(sessionId)
      if (url) return url
    } catch {
      // 404s until the upload lands — keep polling
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return undefined
}

// patchright-core is the client the Solari SDK ships with.
import type { Page, Locator } from "patchright-core"

function adaptPage(page: Page): BrokerPage {
  // Deliberately NOT Object.assign'ing onto the page — that shadows the
  // page's own methods with wrappers that call themselves (infinite
  // recursion). This is a plain closure object instead.
  return {
    goto: (url, opts) => page.goto(url, opts).then(() => undefined),
    locator: (selector) => adaptLocator(page.locator(selector)),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    url: () => page.url(),
    screenshot: (opts) => page.screenshot(opts) as Promise<Buffer>,
  }
}

function adaptLocator(locator: Locator): import("@/types").BrokerLocator {
  return {
    click: () => locator.click() as Promise<void>,
    fill: (v) => locator.fill(v) as Promise<void>,
    type: (t) => locator.type(t) as Promise<void>,
    selectOption: (v) => locator.selectOption(v as never) as unknown as Promise<void>,
    press: (k) => locator.press(k) as Promise<void>,
    first: () => adaptLocator(locator.first()),
    nth: (i) => adaptLocator(locator.nth(i)),
    waitFor: (state) => locator.waitFor({ state }) as Promise<void>,
    innerText: () => locator.innerText(),
    allInnerTexts: () => locator.allInnerTexts() as unknown as Promise<string[]>,
    count: () => locator.count(),
    isVisible: () => locator.isVisible(),
    getAttribute: (n) => locator.getAttribute(n),
  }
}
