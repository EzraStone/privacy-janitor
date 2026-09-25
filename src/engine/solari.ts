/**
 * Solari session engine.
 *
 * Every broker interaction runs through here so all sessions get the same
 * recipe: stealth + captcha solving + session recording + a sticky US
 * residential proxy. Callers can reuse one sticky label across multiple
 * browser sessions that belong to the same logical flow.
 *
 * Encodes the Solari cookbook gotchas:
 *   - ALWAYS close the browser so the remote session is released promptly
 *   - replay uploads are async — poll getReplayUrl for up to ~30s
 *   - stealth is a prerequisite for proxy + captcha
 */
import { Solari } from "@solarisdk/browser"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BrokerPage } from "@/types"
import { getEvidenceDir } from "../config/paths.ts"
import { keyStatus } from "../config/setup.ts"

export interface RunEvidence {
  runId: string
  evidenceDir: string
  proxySessionId: string
  stealth: boolean
  screenshot: (name: string, png: Buffer) => string // returns saved path
  sessionId?: string
  replayUrl?: string
}

type SolariGlobal = typeof globalThis & {
  __pjSolariClient?: Solari
}

const solariGlobal = globalThis as SolariGlobal

export function getSolariClient(): Solari {
  const apiKey = process.env.SOLARI_API_KEY?.trim()
  if (!apiKey || keyStatus(apiKey) !== "configured") {
    throw new Error(
      "SOLARI_API_KEY is not set. Copy .env.example to .env and add your key from https://console.getsolari.com",
    )
  }
  // Reuse one SDK client across Next.js requests and development reloads. The
  // SDK owns a loopback proxy listener; constructing a client per flow leaves
  // unnecessary listeners alive in a long-running local server. A changed API
  // key intentionally requires an app restart because this instance captures it.
  return solariGlobal.__pjSolariClient ??= new Solari({
    apiKey,
    baseUrl: "https://api.getsolari.com",
  })
}

/**
 * Solari documents sticky-proxy session ids as alphanumeric/dash labels with
 * a 32-character maximum. Human-readable run ids can exceed that limit —
 * `confirm-fastpeoplesearch-<ts>` is already 33 characters.
 *
 * Keep as much of the readable run id as fits, then a short digest so two runs
 * sharing a prefix still pin to different egress IPs.
 */
const MAX_PROXY_SESSION_ID = 32

export function proxySessionId(runId: string): string {
  const normalized = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const source = normalized || `pj-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`
  if (source.length <= MAX_PROXY_SESSION_ID) return source
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 8)
  return `${source.slice(0, MAX_PROXY_SESSION_ID - digest.length - 1)}-${digest}`
}

export function createProxySessionId(scope: string): string {
  const nonce = randomUUID().replace(/-/g, "").slice(0, 12)
  return proxySessionId(`${scope}-${nonce}`)
}

/**
 * Minutes during which the same label can reconnect separate browser sessions
 * to the same egress IP. Solari accepts 1-30 and the pin lapses on the clock,
 * so preview and submit share the IP only when approval happens in this window.
 * One still-open browser session already keeps its resolved proxy independently.
 */
const PROXY_SESSION_MINUTES = 30

/** Required broker capabilities. Unsupported plans fail with setup guidance. */
const STEALTH_RECIPE = {
  stealth: true,
  captcha: true,
  recording: true,
  proxy: { country: "us", session: "", sessionDuration: PROXY_SESSION_MINUTES },
} as const

export async function launchResilient(
  client: Solari,
  stickySessionId: string,
): Promise<{ browser: Awaited<ReturnType<Solari["launch"]>>; stealth: boolean }> {
  try {
    const browser = await client.launch({
      ...STEALTH_RECIPE,
      proxy: {
        country: "us",
        session: proxySessionId(stickySessionId),
        sessionDuration: PROXY_SESSION_MINUTES,
      },
    })
    return { browser, stealth: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("FeatureRequiresPlan") || msg.includes("paid plan")) {
      throw new Error(
        "Your Solari provider plan does not support the requested browser capabilities. " +
        "Check stealth, residential proxy, CAPTCHA and recording access in the Solari console before retrying. No fallback browser was opened.",
      )
    }
    throw err
  }
}

/** The evidence folder and screenshot writer for one broker session.
 *  Screenshots are images of a real person's broker listings: owner-only. */
export function createRunEvidence(runId: string, stickySessionId: string): RunEvidence {
  const evidenceDir = join(getEvidenceDir(), runId)
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  return {
    runId,
    evidenceDir,
    proxySessionId: stickySessionId,
    stealth: false,
    screenshot: (name: string, png: Buffer) => {
      const p = join(evidenceDir, `${name}.png`)
      writeFileSync(p, png, { mode: 0o600 })
      return p
    },
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
  options: { proxySessionId?: string } = {},
): Promise<{ result: T; evidence: RunEvidence }> {
  const client = getSolariClient()
  const runId = `${flowName}-${Date.now().toString(36)}`
  const evidence = createRunEvidence(runId, proxySessionId(options.proxySessionId ?? runId))

  const { browser, stealth } = await launchResilient(client, evidence.proxySessionId)

  evidence.sessionId = browser.id
  evidence.stealth = stealth

  try {
    const rawPage = await browser.newPage()
    // Wrap (NOT mutate) the Playwright page — adapters get the BrokerPage
    // surface; orchestrator code needing raw Playwright APIs uses rawPage.
    const page = adaptPage(rawPage)
    const result = await fn(page, evidence, rawPage)
    return { result, evidence }
  } finally {
    await browser.close()
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
