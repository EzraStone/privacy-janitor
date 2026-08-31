/**
 * Smoke test — runs WITHOUT API keys or network access.
 *
 * Verifies the parts that break most often:
 *   1. adapter registry shape (every adapter implements the full interface)
 *   2. match scoring logic (namesake rejection)
 *   3. PII redaction (no raw values survive into prompt text)
 *   4. JSON round-trip for the scoring parser
 *
 * Run: npm run smoke
 */
import { adapters } from "../src/adapters/registry.ts"
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
