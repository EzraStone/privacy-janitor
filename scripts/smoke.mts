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
  ageFrom,
  emailsFrom,
  isPersonProfileSlug,
  namesFrom,
  phonesFrom,
  requireProfileName,
  scoreMatch,
} from "../src/adapters/helpers.ts"
import { buildRedactionMap, redactText, redactListing } from "../src/scoring/redact.ts"
import { parseExposureReport } from "../src/scoring/index.ts"
import type { BrokerPage, Identity, Listing } from "../src/types.ts"

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
// Two-letter state codes are words, not substrings: "MA" is inside "Main",
// "CA" inside "Chicago", "IL" inside "Hill".
const stateOnly = (address: string, city: string, state: string) =>
  scoreMatch("Pat Doe", "Pat Doe", [address], city, state) - scoreMatch("Pat Doe", "Pat Doe", [], city, state)
check("MA is not matched inside Main St", stateOnly("12 Main St, Austin, TX", "Boston", "MA") === 0)
check("CA is not matched inside Chicago", stateOnly("9 Oak Ave, Chicago, IL", "Fresno", "CA") === 0)
check("a Springfield MA namesake on Hill St is not a Springfield IL match",
  stateOnly("4 Hill St, Springfield, MA", "Springfield", "IL") === 0)
check("a same-state address still earns state credit", stateOnly("7 Elm St, Peoria, IL 61602", "Chicago", "IL") > 0)
// Names compare as words. A middle initial is the most common broker display
// variant and must still count; a short fragment of the name must not.
const nameOnly = (shown: string, wanted: string) => scoreMatch(shown, wanted, [], "Chicago", "IL")
check("a middle initial still earns name credit", nameOnly("Jordan A Example", "Jordan Example") > 0)
check("a fragment of the name earns nothing", nameOnly("Jo", "Jordan Example") === 0)
check("case and spacing do not block an exact match", nameOnly("  JORDAN   example ", "Jordan Example") === nameOnly("Jordan Example", "Jordan Example"))
check("accents stripped by a broker still match exactly", nameOnly("Jose Garcia", "José García") === nameOnly("José García", "José García"))
check("a surname alone keeps partial credit", nameOnly("Example", "Jordan Example") > 0)

console.log("smoke: profile URL slugs")
// Slugs are ASCII and hyphen-joined, so a surname can lose its accents,
// apostrophe or own hyphen on the way into the URL — and still be the person.
const slugMatches = (slug: string, fullName: string) => isPersonProfileSlug(slug, { fullName })
check("a plain slug matches", slugMatches("Jordan-Example", "Jordan Example"))
check("a middle initial in the slug matches", slugMatches("Jordan-A-Example", "Jordan Example"))
check("a generational suffix is ignored", slugMatches("John-Smith-Jr", "John Smith"))
check("a hyphenated surname matches", slugMatches("Mary-Smith-Jones", "Mary Smith-Jones"))
check("an apostrophe surname matches without it", slugMatches("Conor-OBrien", "Conor O'Brien"))
check("an apostrophe surname matches split in two", slugMatches("Conor-O-Brien", "Conor O'Brien"))
check("an accented name matches its ASCII slug", slugMatches("Jose-Garcia", "José García"))
check("a percent-encoded slug is decoded", slugMatches("Jos%C3%A9-Garc%C3%ADa", "José García"))
check("a different surname does not match", !slugMatches("Jordan-Examples", "Jordan Example"))
check("a different first name does not match", !slugMatches("Pat-Example", "Jordan Example"))
check("the surname cannot consume the first name", !slugMatches("Smith-Jones", "Mary Smith-Jones"))

console.log("smoke: profile heading verification")
// The profile heading is where a broker proves the page is about this person;
// brokers often print names without the accents the profile was saved with.
const headed = (heading: string) => ({
  locator: () => ({ first: () => ({ isVisible: async () => true, innerText: async () => heading }) }),
}) as unknown as BrokerPage
const verifies = (heading: string, fullName: string) =>
  requireProfileName(headed(heading), { fullName }).then(() => true, () => false)
check("a matching heading verifies", await verifies("Jordan Example", "Jordan Example"))
check("a heading without the profile's accents verifies", await verifies("Jose Garcia", "José García"))
check("an accented heading verifies an ASCII profile", await verifies("José García", "Jose Garcia"))
check("a hyphenated surname heading verifies", await verifies("Mary Smith-Jones, 42", "Mary Smith-Jones"))
check("a different surname does not verify", !(await verifies("Jordan Sample", "Jordan Example")))

console.log("smoke: scraped ages are sanity-checked")
// Loose age selectors also match page wrappers and pagination, and an age
// card that reads "Page 1 of 3" misleads the "Is this you?" decision.
check("a bare age is kept", ageFrom(["42"]) === "42")
check("a labelled age keeps just its number", ageFrom(["Age: 42"]) === "42")
check("a decade age keeps its decade", ageFrom(["Age 40s"]) === "40s")
check("the first real age wins", ageFrom(["Page 1 of 3", "42 years old"]) === "42")
// Normalized so the card reads "age 42", not "age Age: 42", and so match
// scoring can parse it.
check("a normalized age parses for match scoring",
  scoreMatch("Pat Doe", "Pat Doe", [], "Chicago", "IL", { age: ageFrom(["Age: 42"]), ageRange: "40-45" }) >
  scoreMatch("Pat Doe", "Pat Doe", [], "Chicago", "IL"))
check("a result count is not an age", ageFrom(["Showing 25 results"]) === undefined)
check("pagination is not an age", ageFrom(["Page 25"]) === undefined)
check("a whole page section is not an age",
  ageFrom(["Jordan Example\nAge 42\n742 Evergreen Terrace, Chicago, IL"]) === undefined)

console.log("smoke: scraped relatives are sanity-checked")
// ".relative" is also a common CSS utility class, so a relatives selector can
// catch whole layout blocks. A relative is a short, single-line name.
check("names are kept and trimmed",
  JSON.stringify(namesFrom(["Casey Example", " Lane Example "])) === JSON.stringify(["Casey Example", "Lane Example"]))
check("a layout block is dropped", namesFrom(["Jordan Example\nAge 42\n742 Evergreen Terrace"]).length === 0)
check("an overlong line is dropped", namesFrom(["Relatives " + "and associates ".repeat(5)]).length === 0)
check("text without letters is dropped", namesFrom(["123", "—"]).length === 0)

console.log("smoke: scraped phones are sanity-checked")
// A phone selector can match the container that holds several numbers; split
// it into the numbers rather than keeping one blob or dropping it.
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b)
check("a phone is kept", same(phonesFrom(["(312) 555-0100"]), ["(312) 555-0100"]))
check("a container is split into its phones",
  same(phonesFrom(["Phone numbers\n(312) 555-0100\n312.555.0199\nShow more"]), ["(312) 555-0100", "312.555.0199"]))
check("repeated numbers collapse", same(phonesFrom(["(312) 555-0100", "312-555-0100"]), ["(312) 555-0100"]))
check("years and ZIP codes are not phones", phonesFrom(["2024", "62704"]).length === 0)

console.log("smoke: scraped emails are sanity-checked")
// A mailto selector also matches the broker's own "contact us" link, which is
// neither an email address nor the person's.
check("an email is kept", same(emailsFrom(["jordan@example.com"], "spokeo.com"), ["jordan@example.com"]))
check("a mailto label is not an email", emailsFrom(["Email us"], "spokeo.com").length === 0)
check("the broker's own address is not the person's",
  emailsFrom(["support@spokeo.com", "help@mail.spokeo.com"], "spokeo.com").length === 0)
check("repeated emails collapse",
  same(emailsFrom(["Jordan@Example.com", "jordan@example.com"], "spokeo.com"), ["Jordan@Example.com"]))

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
const emptyMap = buildRedactionMap(typedIdentity, [])
const fencedReport = parseExposureReport('```json\n{"rankings":[],"summary":"ok"}\n```', [], emptyMap, "test-model")
check("fence-stripped JSON parses", fencedReport.summary === "ok")
let unparseableRejected = false
try { parseExposureReport("not json at all", [], emptyMap, "test-model") } catch { unparseableRejected = true }
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
]), pair, emptyMap, "test-model")
check("out-of-range, repeated and unscored rankings are dropped",
  noisy.rankings.length === 1 && noisy.rankings[0].listingId === "lst_a")
check("the first ranking for a listing wins", noisy.rankings[0].score === 80)
check("total score stays a number", noisy.totalScore === 80)
check("numeric-string scores are accepted",
  parseExposureReport(rank([{ listing_index: 1, score: "42", rationale: "", recommended_action: "" }]), pair, emptyMap, "m").totalScore === 42)
let emptyRejected = false
try { parseExposureReport(rank([]), pair, emptyMap, "test-model") } catch { emptyRejected = true }
check("no usable rankings is an error, not a reassuring 0/100", emptyRejected)

// The model can only speak in tokens; the user must read their real values.
const restoreMap = buildRedactionMap(typedIdentity, [typedListing])
const homeAddress = typedListing.exposedData.addresses![0]
const phone = typedListing.exposedData.phones![0]
const tokenFor = (value: string) => restoreMap.valueToToken.get(value.toLowerCase())!
const restored = parseExposureReport(JSON.stringify({
  rankings: [{
    listing_index: 0, score: 70,
    rationale: `Exposes ${tokenFor(homeAddress)} and ${tokenFor(phone)}.`,
    recommended_action: `Remove ${tokenFor(typedIdentity.fullName)} from this broker first.`,
  }],
  summary: `${tokenFor(typedIdentity.fullName)} is findable at ${tokenFor(homeAddress)}. See [ADDR_99].`,
}), [typedListing], restoreMap, "test-model")
check("rationale shows the user real values", restored.rankings[0].rationale === `Exposes ${homeAddress} and ${phone}.`)
check("recommended action shows real values",
  restored.rankings[0].recommendedAction === `Remove ${typedIdentity.fullName} from this broker first.`)
check("summary shows real values; invented tokens stay as written",
  restored.summary === `${typedIdentity.fullName} is findable at ${homeAddress}. See [ADDR_99].`)

console.log("")
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
} else {
  console.log("all smoke checks passed ✓")
}
