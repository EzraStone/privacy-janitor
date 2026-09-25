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
import {
  classifyBrokerScan,
  isNoResultText,
  scoreMatch,
} from "../src/adapters/helpers.ts"
import { buildRedactionMap, redactText, redactListing } from "../src/scoring/redact.ts"
import { parseExposureReport } from "../src/scoring/index.ts"
import type { Identity, Listing } from "../src/types.ts"

let failures = 0
function check(name: string, cond: boolean) {
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

console.log("smoke: conservative broker scan outcomes")
check("zero-result text does not match 10 results", !isNoResultText("10 results", ["0 results"]))
check("standalone zero-result text is recognized", isNoResultText("Showing 0 results", ["0 results"]))
check(
  "recognized no-results page is clear",
  classifyBrokerScan({
    listings: [],
    candidateCount: 0,
    failedProfiles: 0,
    candidateLimit: 5,
    searchPageText: "No results found for this search",
    explicitNoResults: true,
    hasMoreResults: false,
  }).outcome === "clear",
)
check(
  "unknown empty page is inconclusive",
  classifyBrokerScan({
    listings: [],
    candidateCount: 0,
    failedProfiles: 0,
    candidateLimit: 5,
    searchPageText: "Welcome back",
    explicitNoResults: false,
    hasMoreResults: false,
  }).outcome === "inconclusive",
)
check(
  "broker challenge cannot be treated as clear",
  classifyBrokerScan({
    listings: [],
    candidateCount: 0,
    failedProfiles: 0,
    candidateLimit: 5,
    searchPageText: "Verify you are human. No results found.",
    explicitNoResults: true,
    hasMoreResults: false,
  }).outcome === "inconclusive",
)
check(
  "partial profile extraction is inconclusive",
  classifyBrokerScan({
    listings: [listing],
    candidateCount: 2,
    failedProfiles: 1,
    candidateLimit: 5,
    searchPageText: "Search results",
    explicitNoResults: false,
    hasMoreResults: false,
  }).outcome === "inconclusive",
)
check(
  "pagination prevents a conclusive scan",
  classifyBrokerScan({
    listings: [listing],
    candidateCount: 1,
    failedProfiles: 0,
    candidateLimit: 5,
    searchPageText: "Search results",
    explicitNoResults: false,
    hasMoreResults: true,
  }).outcome === "inconclusive",
)
check(
  "candidate cap prevents a conclusive scan",
  classifyBrokerScan({
    listings: [listing],
    candidateCount: 5,
    failedProfiles: 0,
    candidateLimit: 5,
    searchPageText: "Search results",
    explicitNoResults: false,
    hasMoreResults: false,
  }).outcome === "inconclusive",
)

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

console.log("smoke: redaction token types follow the source field")
// Types come from the field a value was found in, never from its content: a
// ZIP code made every full address look like a phone number, and a relative
// named "Lane" looked like a street. A wrong type reaches the model and comes
// back to the user in its rationale ("phone 742 Evergreen Terrace...").
const typedIdentity: Identity = {
  id: "id_typed", fullName: "Jordan Example", city: "Chicago", stateCode: "IL",
  relatives: ["Casey Example"], createdAt: new Date().toISOString(),
}
const typedListing: Listing = {
  id: "lst_typed", brokerId: "spokeo", identityId: typedIdentity.id, url: "https://www.spokeo.com/x",
  displayName: "Jordan A Example", confirmedMine: true,
  firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
  exposedData: {
    addresses: ["742 Evergreen Terrace, Springfield, IL 62704", "PO Box 1234, Chicago, IL"],
    phones: ["(312) 555-0100"], emails: ["jordan@example.com"],
    relatives: ["Lane Example", "Casey Example"], aliases: ["J. Example"],
  },
}
const typedLines = new Map(
  redactListing(typedListing, buildRedactionMap(typedIdentity, [typedListing]))
    .split("\n").map((line) => [line.split(":")[0], line] as const),
)
const onlyTokens = (field: string, kind: string) => {
  const tokens = typedLines.get(field)?.match(/\[[A-Z]+_\d+\]/g) ?? []
  return tokens.length > 0 && tokens.every((token) => token.startsWith(`[${kind}_`))
}
check("addresses with ZIP codes are ADDR, not PHONE", onlyTokens("addresses", "ADDR"))
check("relatives are RELATIVE, even one named Lane", onlyTokens("relatives_listed", "RELATIVE"))
check("display name variants are the subject's NAME", onlyTokens("display_name", "NAME"))
check("aliases are the subject's NAME", onlyTokens("aliases", "NAME"))
check("phones are PHONE", onlyTokens("phones", "PHONE"))
check("emails are EMAIL", onlyTokens("emails", "EMAIL"))

// Profiles saved before server-side trimming can hold blank values. A blank
// key would compile to an empty pattern and splice a token between every
// character of the prompt.
const legacy: Identity = { ...typedIdentity, city: "", relatives: ["", "Casey Example"] }
const legacyText = redactText("Casey Example lives near Chicago", buildRedactionMap(legacy, []))
check("blank legacy values never inject tokens", legacyText === "[RELATIVE_1] lives near Chicago")

console.log("smoke: scoring parser tolerance")
// Exercise the real parser, not a reimplementation of its fence stripping.
const fencedReport = parseExposureReport('```json\n{"rankings":[],"summary":"ok"}\n```', [], "test-model")
check("fence-stripped JSON parses", fencedReport.summary === "ok")
let unparseableRejected = false
try { parseExposureReport("not json at all", [], "test-model") } catch { unparseableRejected = true }
check("unparseable model output is rejected", unparseableRejected)

// The model's reply is untrusted: indices can repeat or point past the list,
// and scores can be missing or non-numeric.
const pair: Listing[] = [
  { ...typedListing, id: "lst_a", brokerId: "spokeo" },
  { ...typedListing, id: "lst_b", brokerId: "whitepages" },
]
const rank = (rankings: unknown[]) => JSON.stringify({ rankings, summary: "s" })
const noisy = parseExposureReport(rank([
  { listing_index: 0, score: 80, rationale: "a", recommended_action: "x" },
  { listing_index: 0, score: 10, rationale: "repeat", recommended_action: "x" },
  { listing_index: 5, score: 99, rationale: "past the end", recommended_action: "x" },
  { listing_index: -1, score: 99, rationale: "negative", recommended_action: "x" },
  { listing_index: 1, score: "high", rationale: "not a number", recommended_action: "x" },
]), pair, "test-model")
check("out-of-range, repeated and unscored rankings are dropped",
  noisy.rankings.length === 1 && noisy.rankings[0].listingId === "lst_a")
check("the first ranking for a listing wins", noisy.rankings[0].score === 80)
check("total score stays a number", noisy.totalScore === 80)
check("numeric-string scores are accepted",
  parseExposureReport(rank([{ listing_index: 1, score: "42", rationale: "", recommended_action: "" }]), pair, "m").totalScore === 42)
let emptyRejected = false
try { parseExposureReport(rank([]), pair, "test-model") } catch { emptyRejected = true }
check("no usable rankings is an error, not a reassuring 0/100", emptyRejected)

console.log("")
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
} else {
  console.log("all smoke checks passed ✓")
}
