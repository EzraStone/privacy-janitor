/**
 * Solari session engine.
 *
 * Every broker interaction runs through here so all sessions get the same
 * recipe: stealth + captcha solving + session recording + a sticky US
 * residential proxy (one consistent egress IP per run, so brokers don't see
 * us hop countries mid-flow).
 *
 * Encodes the Solari cookbook gotchas:
 *   - ALWAYS close the browser (skip it and the script hangs forever)
 *   - replay uploads are async — poll getReplayUrl for up to ~30s
 *   - stealth is a prerequisite for proxy + captcha
 */
import { Solari } from "@solarisdk/browser"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BrokerPage } from "@/types"

const EVIDENCE_DIR = join(process.cwd(), "data", "evidence")

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

/** Launch options that degrade to the free plan when stealth is paywalled. */
const STEALTH_RECIPE = {
  stealth: true,
  captcha: true,
  recording: true,
  proxy: { country: "us", session: "", sessionDuration: 30 },
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
      proxy: { country: "us", session: runId, sessionDuration: 30 },
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
  fn: (page: Page & BrokerPage, evidence: RunEvidence) => Promise<T>,
): Promise<{ result: T; evidence: RunEvidence }> {
  const client = getSolariClient()
  const runId = `${flowName}-${Date.now().toString(36)}`
  const evidenceDir = join(EVIDENCE_DIR, runId)
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
    // Adapt Playwright Page -> BrokerPage so adapters never import Solari
    // types directly and stay unit-testable.
    const page = adaptPage(rawPage)
    const result = await fn(page, evidence)
    return { result, evidence }
  } finally {
    await browser.close() // never skip — the SDK hangs if you do
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

function adaptPage(page: Page): Page & BrokerPage {
  const adapted: BrokerPage = {
    goto: (url, opts) => page.goto(url, opts) as unknown as Promise<void>,
    locator: (selector) => adaptLocator(page.locator(selector)),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    url: () => page.url(),
    screenshot: (opts) => page.screenshot(opts) as Promise<Buffer>,
  }
  return Object.assign(page, adapted)
}

function adaptLocator(locator: Locator): import("@/types").BrokerLocator {
  return {
    click: () => locator.click() as Promise<void>,
    fill: (v) => locator.fill(v) as Promise<void>,
    type: (t) => locator.type(t) as Promise<void>,
    selectOption: (v) => locator.selectOption(v) as unknown as Promise<void>,
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
