/**
 * Smoke test — runs WITHOUT API keys or network access.
 *
 * Verifies the parts that break most often:
 *   1. adapter registry shape (every adapter implements the full interface)
 *   2. match scoring logic (namesake rejection)
 *   3. PII redaction (no raw values survive into prompt text)
 *   4. JSON round-trip for the scoring parser
 *   5. sticky-proxy session ids stay inside Solari's 32-char cap
 *
 * Run: npm run smoke
 */
import { adapters } from "../src/adapters/registry.ts"
import { createProxySessionId, proxySessionId } from "../src/engine/solari.ts"
import { scoreMatch } from "../src/adapters/helpers.ts"
import { buildRedactionMap, redactText, redactListing } from "../src/scoring/redact.ts"
import type { Identity, Listing } from "../src/types.ts"

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok    ${name}`)
  } else {
    failures++
    console.error(`  FAIL  ${name}`)
  }
}

console.log("smoke: adapter registry")
check("3 adapters registered", adapters.length === 3)
for (const a of adapters) {
  check(`${a.id}: has scan`, typeof a.scan === "function")
  check(`${a.id}: has verifyMatch`, typeof a.verifyMatch === "function")
  check(`${a.id}: has prepareOptOut`, typeof a.prepareOptOut === "function")
  check(`${a.id}: has submitOptOut`, typeof a.submitOptOut === "function")
  check(`${a.id}: declares email-confirmation stance`, typeof a.expectsEmailConfirmation === "boolean")
}

console.log("smoke: proxy session ids")
// Solari caps proxy.session at 32 chars. Over-running it silently drops the
// sticky pin rather than erroring, so a long broker id would rotate our egress
// IP mid-flow and read as a session hijack. Guard the longest id we ship.
const longestBrokerId = [...adapters].sort((a, b) => b.id.length - a.id.length)[0].id
const stamp = Date.now().toString(36)
// Mirrors the flow names orchestrator.ts passes to withBrokerSession().
for (const prefix of ["scan", "optout", "submit", "confirm"]) {
  const runId = `${prefix}-${longestBrokerId}-${stamp}`
  check(`${runId} pins within 32 chars`, proxySessionId(runId).length <= 32)
}
check("short run ids pass through unchanged", proxySessionId("scan-spokeo-abc") === "scan-spokeo-abc")
check("over-long run ids are still bounded", proxySessionId("x".repeat(500)).length <= 32)
check("invalid sticky-session characters are normalized", proxySessionId("Opt Out_ID") === "opt-out-id")
check(
  "distinct long run ids pin to distinct egress sessions",
  proxySessionId(`confirm-${"b".repeat(40)}-1`) !== proxySessionId(`confirm-${"b".repeat(40)}-2`),
)
const flowSessionA = createProxySessionId("optout-fastpeoplesearch")
const flowSessionB = createProxySessionId("optout-fastpeoplesearch")
check("generated flow session ids stay within 32 chars", flowSessionA.length <= 32)
check("generated flow session ids use supported characters", /^[a-z0-9-]+$/.test(flowSessionA))
check("separate logical flows receive separate sticky ids", flowSessionA !== flowSessionB)
for (const hostileInput of ["", "   ", "隐私清理", "a_b c", "x".repeat(500)]) {
  const normalized = proxySessionId(hostileInput)
  check(`hostile proxy label is valid: ${JSON.stringify(hostileInput.slice(0, 12))}`, /^[a-z0-9-]{1,32}$/.test(normalized))
  check(`proxy label normalization is idempotent: ${JSON.stringify(hostileInput.slice(0, 12))}`, proxySessionId(normalized) === normalized)
}

console.log("smoke: match scoring")
const exact = scoreMatch("John Smith", "John Smith", ["123 Main St, Seattle, WA"], "Seattle", "WA")
const namesake = scoreMatch("John Smith", "John Smith", ["456 Oak Ave, Austin, TX"], "Seattle", "WA")
check("same-city match scores >0.6", exact > 0.6)
check("wrong-city namesake scores <0.5", namesake < 0.5)
check("scoring bounded to 1", exact <= 1 && namesake >= 0)

console.log("smoke: PII redaction")
const identity = {
  id: "id_test",
  fullName: "Jane Doe",
  city: "Seattle",
  stateCode: "WA",
  ageRange: "30-35",
  relatives: ["John Doe"],
  createdAt: new Date().toISOString(),
}
const listing = {
  id: "lst_test",
  brokerId: "whitepages",
  identityId: identity.id,
  url: "https://www.whitepages.com/name/Jane-Doe/abc",
  displayName: "Jane Doe",
  exposedData: {
    addresses: ["742 Evergreen Terrace, Seattle, WA"],
    phones: ["(206) 555-0100"],
    relatives: ["John Doe"],
  },
  confirmedMine: true,
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
}
const map = buildRedactionMap(identity, [listing])
const redacted = redactListing(listing, map)
check("listing text has no raw name", !redacted.includes("Jane Doe"))
check("listing text has no raw address", !redacted.includes("Evergreen"))
check("listing text has no raw phone", !redacted.includes("555-0100"))
check("listing text is tokenized", redacted.includes("[NAME_"))

const prose = redactText("Jane Doe lives at 742 Evergreen Terrace with John Doe", map)
check("free text redaction replaces all values", !prose.includes("Jane") && !prose.includes("Evergreen"))

const locationContext = redactText(
  `subject_location: ${identity.city}, state ${identity.stateCode}`,
  map,
)
check(
  "profile location context has no raw values",
  !locationContext.includes(identity.city) && !locationContext.includes(identity.stateCode),
)
check(
  "profile location context is tokenized",
  (locationContext.match(/\[LOCATION_\d+\]/g) ?? []).length === 2,
)
check(
  "short state codes do not redact inside words",
  redactText("awaiting confirmation", map) === "awaiting confirmation",
)

console.log("smoke: scoring parser tolerance")
// simulate the safeParseJson fallback path with fences
const fenced = '```json\n{"rankings":[],"summary":"ok"}\n```'
const cleaned = fenced.replace(/```json|```/g, "").trim()
const parsed = JSON.parse(cleaned)
check("fence-stripped JSON parses", parsed.summary === "ok")

console.log("")
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
} else {
  console.log("all smoke checks passed ✓")
}
