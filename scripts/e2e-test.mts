/**
 * End-to-end live test through the REAL orchestrator (no UI needed).
 * Uses a public-figure-style identity, not user PII.
 * Run: node --experimental-strip-types scripts/e2e-test.mts
 */
import "dotenv/config"
import * as store from "../src/store/index.ts"
import { runScan } from "../src/engine/orchestrator.ts"
import { scoreExposure } from "../src/scoring/index.ts"

const identity = {
  id: "id_e2e_test",
  fullName: "John Smith",
  city: "Seattle",
  stateCode: "WA",
  ageRange: "40-45",
  createdAt: new Date().toISOString(),
}

store.saveIdentity(identity)
console.log("identity saved; running live scan against all 3 brokers…")
const run = await runScan(identity.id)
console.log("scan finished:", run.results)

const listings = store.listListings(identity.id)
console.log(`total listings found: ${listings.length}`)
for (const l of listings) {
  console.log(`- [${l.brokerId}] ${l.displayName}:`, {
    addresses: l.exposedData.addresses?.length ?? 0,
    phones: l.exposedData.phones?.length ?? 0,
    url: l.url,
  })
}

if (listings.length > 0) {
  // Pretend the user confirmed the top 2 listings, then score them.
  const confirmed = listings.slice(0, 2).map((l) => ({ ...l, confirmedMine: true }))
  console.log("\nscoring (redacted prompts -> Groq)…")
  try {
    const report = await scoreExposure(identity, confirmed)
    console.log("exposure total:", report.totalScore, "/ 100")
    console.log("summary:", report.summary)
    for (const r of report.rankings) {
      console.log(`  ${r.brokerId} [${r.score}/100]: ${r.rationale}`)
    }
  } catch (e) {
    console.error("scoring failed:", e instanceof Error ? e.message : e)
  }
}

process.exit(0)
